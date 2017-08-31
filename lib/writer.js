"use strict";
var thrift = require('thrift');
var pako = require('pako');
var parquet_thrift = require('../gen-nodejs/parquet_types')
var parquet_shredder = require('./shred')
var parquet_util = require('./util')

/**
 * Parquet File Magic String
 */
const PARQUET_MAGIC = "PAR1";

/**
 * Parquet File Format Version
 */
const PARQUET_VERSION = 1;

/**
 * Default Page and Row Group sizes
 */
const DEFAULT_PAGE_SIZE = 8; // FIXME
const DEFAULT_ROW_GROUP_SIZE = 8; // FIXME
const DEFAULT_DLVL_ENCODING = "PLAIN";
const DEFAULT_RLVL_ENCODING = "PLAIN";
const DEFAULT_PAGE_COMPRESSION = "GZIP";

/**
 * Write a parquet file to an abstract output stream without buffering
 */
function ParquetWriter(schema, output_stream) {
  var os = output_stream;
  var os_offset = 0;
  var row_count = 0;
  var row_groups = [];
  var page_size = DEFAULT_PAGE_SIZE;

  function write(buf) {
    os_offset += buf.length;
    os.write(buf);
  }

  this.writeHeader = function() {
    write(Buffer.from(PARQUET_MAGIC));
  }

  this.writeRowGroup = function(rows) {
    var rows_shredded = parquet_shredder.shredRecords(schema, rows);

    var rgroup = new parquet_thrift.RowGroup();
    rgroup.num_rows = rows.length;
    rgroup.columns = [];
    rgroup.total_byte_size = 0;

    schema.columns.forEach(function(col_def) {
      var cchunk_data = encodeColumnChunk({
        column: col_def,
        values: rows_shredded[col_def.name],
        base_offset: os_offset,
        page_size: page_size,
        encoding: "PLAIN" // FIXME
      });

      var cchunk = new parquet_thrift.ColumnChunk();
      cchunk.file_offset = cchunk_data.metadata_offset;
      cchunk.meta_data = cchunk_data.metadata;
      console.log(cchunk);
      rgroup.columns.push(cchunk);
      rgroup.total_byte_size += cchunk_data.body.length;

      write(cchunk_data.body);
    });

    row_count += rows.length;
    row_groups.push(rgroup);
  }

  this.writeFooter = function() {
    if (row_count == 0) {
      throw "can't write parquet file with zero rows";
    }

    if (schema.columns.length == 0) {
      throw "can't write parquet file with zero columns";
    }

    // prepare parquet file metadata message
    var fmd = new parquet_thrift.FileMetaData()
    fmd.version = PARQUET_VERSION;
    fmd.created_by = "parquet.js";
    fmd.num_rows = row_count;
    fmd.row_groups = row_groups;
    fmd.schema = [];

    schema.columns.forEach(function(col_def) {
      var tcol = new parquet_thrift.SchemaElement();
      tcol.name = col_def.name;
      tcol.type = col_def.thrift_type;
      fmd.schema.push(tcol);
    });

    // write footer data
    var fmd_bin = parquet_util.serializeThrift(fmd);
    write(fmd_bin)

    // 4 bytes footer length, uint32 LE
    var footer = new Buffer(8);
    footer.writeUInt32LE(fmd_bin.length);

    // 4 bytes footer magic 'PAR1'
    footer.fill(PARQUET_MAGIC, 4);
    write(footer);
  };

  this.setPageSize = function(cnt) {
    page_size = cnt;
  }

}

/**
 * Write a parquet file to the file system. The ParquetFileWriter will perform
 * buffering/batching for performance, so end() must be called after all rows
 * are written
 */
class ParquetFileWriter {

  constructor(schema, path) {
    this.os = fs.createWriteStream(path);
    this.row_buffer = [];
    this.row_group_size = DEFAULT_ROW_GROUP_SIZE;
    this.writer = new ParquetWriter(schema, this.os);
    this.writer.writeHeader();
  }

  writeRow(row) {
    this.row_buffer.push(row);

    if (this.row_buffer.length >= this.row_group_size) {
      this.writer.writeRowGroup(this.row_buffer);
      this.row_buffer = [];
    }
  }

  setRowGroupSize(cnt) {
    this.row_group_size = cnt;
  }

  setPageSize(cnt) {
    this.writer.setPageSize(cnt);
  }

  end() {
    if (this.row_buffer.length > 0) {
      this.writer.writeRowGroup(this.row_buffer);
      this.row_buffer = [];
    }

    this.writer.writeFooter();
    this.os.end();
    this.os = null;
  }

}

/**
 * Encode an arary of values intp a parquet page
 */
function encodePage(type, encoding, values) {
  return Buffer.from("test");
}

/**
 * Compress pages
 */
function compressPages(pages, codec) {
  switch (codec) {

    case "GZIP":
      return Buffer.from(pako.gzip(pages));

    default:
      throw "invalid compression codec";

  }
}

/**
 * Encode an array of values into a parquet column chunk
 */
function encodeColumnChunk(opts) {
  var metadata = new parquet_thrift.ColumnMetaData();
  metadata.type = opts.column.thrift_type;
  metadata.path_in_schema = opts.column.path;
  metadata.num_values = opts.values.length;
  metadata.data_page_offset = opts.base_offset;
  metadata.encodings = [];

  /* build pages */
  var values = opts.values;
  var pages = [];

  for (var voff = 0; voff <= values.length; voff += opts.page_size) {
    /* extract page data vectors */
    var page_values = [];
    var page_dlevels = [];
    var page_rlevels = [];

    for (var i = 0; i < Math.min(opts.page_size, values.length - voff); ++i) {
      page_values.push(values[voff + i].value);
      page_values.push(values[voff + i].rlevel);
      page_values.push(values[voff + i].dlevel);
    }

    /* build page header */
    var page_parts = [];
    var page_header = new parquet_thrift.PageHeader()
    page_header.type = parquet_thrift.PageType.DATA_PAGE;
    page_header.num_values = page_values.length;
    page_header.encoding = parquet_thrift.Encoding[page_encoding];
    page_header.definition_level_encoding = parquet_thrift.Encoding[page_dlvl_encoding];
    page_header.repetition_level_encoding = parquet_thrift.Encoding[page_rlvl_encoding];
    page_parts.push(parquet_util.serializeThrift(page_header));

    /* encode page data vectors */
    var page_encoding = opts.encoding;
    var page_dlvl_encoding = opts.dlvl_encoding || DEFAULT_DLVL_ENCODING;
    var page_rlvl_encoding = opts.rlvl_encoding || DEFAULT_RLVL_ENCODING;
    page_parts.push(encodePage(opts.column.type, page_encoding, page_values));
    // add rlevels
    // add dlevels

    /* add page to column chunk */
    if (metadata.encodings.indexOf(parquet_thrift.Encoding[page_encoding]) < 0) {
      metadata.encodings.push(parquet_thrift.Encoding[page_encoding]);
    }

    pages.push(Buffer.concat(page_parts));
  }

  /* compress pages */
  var pages_buf = Buffer.concat(pages);
  var pages_compression = opts.compression || DEFAULT_PAGE_COMPRESSION;
  metadata.total_uncompressed_size = pages_buf.length;
  metadata.codec = parquet_thrift.CompressionCodec[pages_compression];
  pages_buf = compressPages(pages_buf, pages_compression);
  metadata.total_compressed_size = pages_buf.length;

  /* build column chunk */
  var metadata_offset = opts.base_offset + pages_buf.length;
  var body = Buffer.concat([pages_buf, parquet_util.serializeThrift(metadata)]);

  return { body, metadata, metadata_offset };
}

module.exports = {
  ParquetWriter,
  ParquetFileWriter,
};
