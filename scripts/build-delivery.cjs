"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { deflateRawSync } = require("node:zlib");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "deliverables");
const sourceEntries = ["package.json", "package-lock.json", "server.js", "server", "public"];
const archiveName = "doc-editor-source.tar";

function timestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}-${value.hour}${value.minute}${value.second}`;
}

// Copy only runtime sources. Reject links rather than following files outside
// the checkout; exclude local configuration, dependencies and generated data.
function copySource(relative, destination) {
  const name = path.basename(relative);
  if (["node_modules", ".git", "data", "deliverables", ".DS_Store", ".token-secret"].includes(name)
      || name === ".env" || name.startsWith(".env.") || name.endsWith(".log")) return;
  const source = path.join(root, relative);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Source links are not supported: ${relative}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const child of fs.readdirSync(source).sort()) {
      copySource(path.join(relative, child), path.join(destination, child));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
  } else {
    throw new Error(`Unsupported source entry: ${relative}`);
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Three small delivery entries only; ZIP32 + deflate needs no npm dependency.
function createZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = fs.readFileSync(file.path);
    const compressed = deflateRawSync(data);
    if (data.length > 0xffffffff || compressed.length > 0xffffffff) throw new Error("ZIP32 size limit exceeded");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); // DOS date: 1980-01-01.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > 0xffffffff) throw new Error("ZIP32 size limit exceeded");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let staging;
try {
  fs.mkdirSync(outputDir, { recursive: true });
  staging = fs.mkdtempSync(path.join(os.tmpdir(), "doc-editor-delivery-"));
  const sourceDir = path.join(staging, "source");
  fs.mkdirSync(sourceDir);
  for (const entry of sourceEntries) copySource(entry, path.join(sourceDir, entry));
  const sourceArchive = path.join(staging, archiveName);
  const tar = spawnSync("tar", ["-cf", sourceArchive, "-C", sourceDir, ...sourceEntries], {
    encoding: "utf8", windowsHide: true,
  });
  if (tar.error) throw new Error(`Cannot run tar; install tar and add it to PATH: ${tar.error.message}`);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
  const zip = createZip([
    { name: archiveName, path: sourceArchive },
    { name: "Dockerfile", path: path.join(root, "Dockerfile") },
    { name: "compose.yml", path: path.join(root, "docker-compose.yml") },
  ]);
  const output = path.join(outputDir, `doc-editor-deploy-${timestamp()}-${String(Date.now() % 1000).padStart(3, "0")}.zip`);
  fs.writeFileSync(output, zip, { flag: "wx" });
  console.log(`Delivery ZIP: ${output}`);
  console.log(`Contents: ${archiveName}, Dockerfile, compose.yml`);
  console.log("Timestamp timezone: Asia/Shanghai. No Docker engine is needed for packaging.");
} catch (error) {
  console.error(`Delivery build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (staging && path.dirname(staging) === path.resolve(os.tmpdir())
      && path.basename(staging).startsWith("doc-editor-delivery-")) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
