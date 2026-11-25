import { deflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const spreadsheetNamespace =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationships =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationships =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypes =
  "http://schemas.openxmlformats.org/package/2006/content-types";

const xml = (content) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content;
const escapeXml = (value) =>
  String(value ?? "")
    .replace(
      /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,
      "",
    )
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character],
    );

function sheet(rows) {
  const data = rows
    .map((row, index) => {
      const cells = row
        .map((value, column) => {
          const reference = String.fromCharCode(65 + column) + (index + 1);
          return typeof value === "number"
            ? `<c r="${reference}"><v>${value}</v></c>`
            : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${index + 1}">${cells}</row>`;
    })
    .join("");
  return xml(
    `<worksheet xmlns="${spreadsheetNamespace}"><sheetData>${data}</sheetData></worksheet>`,
  );
}

// XLSX is a ZIP of Open XML parts. All ZIP member names below are fixed ASCII.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function zip(parts) {
  const local = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [partName, text] of Object.entries(parts)) {
    const name = Buffer.from(partName);
    const contents = Buffer.from(text);
    const compressed = deflateRawSync(contents);
    let crc = 0xffffffff;
    for (const byte of contents)
      crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
    directorySize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

export function financeWorkbook({ days, entries }) {
  const daily = [
    [
      "Ngày",
      "Số dư đầu kỳ",
      "Thu VND",
      "Chi VND",
      "Số dư cuối kỳ",
      "Nội dung",
      "Trạng thái",
      "Số phiếu",
      "Người chốt",
      "Thời điểm chốt UTC",
    ],
  ];
  for (const day of days)
    daily.push([
      day.businessDate,
      day.openingBalance,
      day.totalIncome,
      day.totalExpense,
      day.closingBalance,
      day.contentSummary,
      day.status,
      day.transactionCount,
      day.closedBy,
      day.closedAt?.toISOString(),
    ]);
  const details = [
    [
      "Ngày phát sinh",
      "Mã phiếu",
      "Thời điểm ghi nhận UTC",
      "Loại",
      "Số tiền VND",
      "Nội dung",
      "Danh mục",
      "Hình thức",
      "Nguồn",
      "Mã nguồn",
      "Người lập",
      "Đối tác",
      "Mã chứng từ",
      "Ghi chú",
      "Trạng thái",
      "ID phiếu gốc",
    ],
  ];
  for (const entry of entries)
    details.push([
      entry.businessDate,
      entry.code,
      entry.createdAt?.toISOString(),
      entry.type,
      entry.amount,
      entry.content,
      entry.category,
      entry.paymentMethod,
      entry.sourceType,
      entry.sourceId,
      entry.createdBy,
      entry.counterparty,
      entry.referenceNo,
      entry.note,
      entry.status,
      entry.reversalOf,
    ]);
  return zip({
    "[Content_Types].xml": xml(
      `<Types xmlns="${contentTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": xml(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": xml(
      `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationships}"><sheets><sheet name="Tổng hợp ngày" sheetId="1" r:id="rId1"/><sheet name="Chi tiết phiếu" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": xml(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationships}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": sheet(daily),
    "xl/worksheets/sheet2.xml": sheet(details),
  });
}
