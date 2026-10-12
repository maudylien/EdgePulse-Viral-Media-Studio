import { C2PAMetadataFields, SrtSubtitleSegment } from "../types/studio";

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateUuidV4(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function buildC2paXmpPacket(
  fields: C2PAMetadataFields,
  sha256Hex: string,
  aspectRatio: string
): string {
  const docId = `xmp.did:${generateUuidV4()}`;
  const instanceId = `xmp.iid:${generateUuidV4()}`;
  const manifestId = `urn:c2pa:${generateUuidV4()}`;
  const nowIso = new Date().toISOString();

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="EdgePulse C2PA/IPTC Engine 2.1">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
      xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
      xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
      xmlns:c2pa="http://c2pa.org/manifest/2.1/"
      xmp:CreatorTool="EdgePulse Cloudflare Worker Media Engine"
      xmp:CreateDate="${nowIso}"
      xmp:ModifyDate="${nowIso}"
      xmp:MetadataDate="${nowIso}"
      xmpMM:DocumentID="${docId}"
      xmpMM:InstanceID="${instanceId}"
      photoshop:Credit="${escapeXml(fields.creditLine)}"
      Iptc4xmpExt:DigitalSourceType="${escapeXml(fields.digitalSourceType)}"
      c2pa:ActiveManifest="${manifestId}"
      c2pa:ContentBindingSha256="${sha256Hex}"
      c2pa:TargetAspectRatio="${escapeXml(aspectRatio)}">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escapeXml(fields.title)}</rdf:li>
        </rdf:Alt>
      </dc:title>
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escapeXml(fields.description)}</rdf:li>
        </rdf:Alt>
      </dc:description>
      <dc:creator>
        <rdf:Seq>
          <rdf:li>${escapeXml(fields.creator)}</rdf:li>
        </rdf:Seq>
      </dc:creator>
      <dc:rights>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${escapeXml(fields.rightsUsageTerms)}</rdf:li>
        </rdf:Alt>
      </dc:rights>
      <c2pa:Assertions>
        <rdf:Seq>
          <rdf:li rdf:parseType="Resource">
            <c2pa:label>c2pa.actions</c2pa:label>
            <c2pa:action>c2pa.color_adjustments</c2pa:action>
            <c2pa:softwareAgent>EdgePulse Client-Side Canvas Pipeline</c2pa:softwareAgent>
            <c2pa:when>${nowIso}</c2pa:when>
          </rdf:li>
        </rdf:Seq>
      </c2pa:Assertions>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export async function computeBlobSha256(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Injects a standards-compliant Adobe XMP / C2PA / IPTC APP1 (0xFFE1) segment
 * directly into a JPEG binary stream right after the SOI (0xFFD8) marker.
 */
export async function injectXmpIntoJpegBlob(
  jpegBlob: Blob,
  xmpXmlString: string,
  stripExistingApp1 = true
): Promise<Blob> {
  const originalBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  if (
    originalBytes.length < 4 ||
    originalBytes[0] !== 0xff ||
    originalBytes[1] !== 0xd8
  ) {
    // Not a JPEG stream; return original blob
    return jpegBlob;
  }

  const encoder = new TextEncoder();
  const xmpHeaderBytes = encoder.encode("http://ns.adobe.com/xap/1.0/\0");
  const xmpPayloadBytes = encoder.encode(xmpXmlString);

  const segmentDataLength = 2 + xmpHeaderBytes.length + xmpPayloadBytes.length;
  if (segmentDataLength > 65535) {
    throw new Error("XMP packet exceeds maximum 64KB JPEG APP1 segment size.");
  }

  const app1Segment = new Uint8Array(2 + segmentDataLength);
  // APP1 Marker: FF E1
  app1Segment[0] = 0xff;
  app1Segment[1] = 0xe1;
  // Big-endian 16-bit segment length (includes the 2 length bytes)
  app1Segment[2] = (segmentDataLength >> 8) & 0xff;
  app1Segment[3] = segmentDataLength & 0xff;
  app1Segment.set(xmpHeaderBytes, 4);
  app1Segment.set(xmpPayloadBytes, 4 + xmpHeaderBytes.length);

  // Optionally strip existing APP1/EXIF/XMP segments to sanitize device fingerprint
  const keptChunks: Uint8Array[] = [];
  let offset = 2; // Skip SOI (FF D8)

  if (stripExistingApp1) {
    while (offset + 4 < originalBytes.length && originalBytes[offset] === 0xff) {
      const marker = originalBytes[offset + 1];
      // Stop at SOS (FF DA) or non-variable markers
      if (marker === 0xda || marker === 0xd9) {
        break;
      }
      const segLen =
        (originalBytes[offset + 2] << 8) | originalBytes[offset + 3];
      if (segLen < 2 || offset + 2 + segLen > originalBytes.length) {
        break;
      }
      // Drop existing APP1 (0xE1) and APP13/IPTC (0xED) metadata noise
      if (marker !== 0xe1 && marker !== 0xed) {
        keptChunks.push(originalBytes.slice(offset, offset + 2 + segLen));
      }
      offset += 2 + segLen;
    }
  }

  const remainder = originalBytes.slice(offset);
  const totalLength =
    2 +
    app1Segment.length +
    keptChunks.reduce((acc, c) => acc + c.length, 0) +
    remainder.length;

  const output = new Uint8Array(totalLength);
  output[0] = 0xff;
  output[1] = 0xd8;
  let writePos = 2;

  output.set(app1Segment, writePos);
  writePos += app1Segment.length;

  for (const chunk of keptChunks) {
    output.set(chunk, writePos);
    writePos += chunk.length;
  }

  output.set(remainder, writePos);

  return new Blob([output], { type: "image/jpeg" });
}

export async function formatBinaryHexHeader(
  blob: Blob,
  byteCount = 96
): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, byteCount).arrayBuffer());
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16);
    const hexPart = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
    const asciiPart = Array.from(slice)
      .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(
      `${i.toString(16).padStart(4, "0").toUpperCase()}  ${hexPart.padEnd(47, " ")}  |${asciiPart}|`
    );
  }
  return lines.join("\n");
}

export function formatSrtContent(segments: SrtSubtitleSegment[]): string {
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${seg.startTime} --> ${seg.endTime}\n${seg.text}\n`
    )
    .join("\n");
}
