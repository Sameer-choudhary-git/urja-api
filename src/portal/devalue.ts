import { PortalProtocolError } from "./errors.js";

/**
 * Decoder for SvelteKit's `__data.json` payloads (the "devalue" format,
 * PROTOCOL.md section 4).
 *
 * devalue flattens a value into one array. Inside objects and lists, every
 * number is an INDEX into that same array, which lets repeated values be
 * stored once:
 *
 *   ["J100001" is at index 1]
 *   arr[0] = { "meterId": 1, "detail": 2 }    -> { meterId: "J100001", detail: ... }
 *
 * Only what the portal was seen to use is supported: objects, lists, strings,
 * numbers, booleans, null. devalue's special encodings (negative indexes for
 * undefined/NaN/Infinity, and tagged lists like ["Date", ...] or ["Map", ...])
 * have not appeared, so they throw instead of being guessed at.
 */
export function decodeDevalue(flat: unknown): unknown {
  if (!Array.isArray(flat) || flat.length === 0) {
    throw new PortalProtocolError("devalue payload must be a non-empty array");
  }
  const decoded = new Map<number, unknown>();
  const inProgress = new Set<number>();

  const decode = (index: unknown): unknown => {
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new PortalProtocolError(`devalue: expected an index, got ${JSON.stringify(index)}`);
    }
    if (index < 0) throw new PortalProtocolError(`devalue: special value ${index} (undefined/NaN/Infinity) is not supported`);
    if (index >= flat.length) throw new PortalProtocolError(`devalue: index ${index} is out of range`);
    if (decoded.has(index)) return decoded.get(index);
    if (inProgress.has(index)) throw new PortalProtocolError(`devalue: cyclic reference at ${index} is not supported`);

    const raw: unknown = flat[index];
    let value: unknown;
    if (Array.isArray(raw)) {
      if (typeof raw[0] === "string") {
        throw new PortalProtocolError(`devalue: tagged value "${raw[0]}" is not supported`);
      }
      inProgress.add(index);
      value = raw.map(decode);
    } else if (raw !== null && typeof raw === "object") {
      inProgress.add(index);
      value = Object.fromEntries(Object.entries(raw).map(([key, child]) => [key, decode(child)]));
    } else {
      value = raw; // string, number, boolean, null: stored as-is
    }
    inProgress.delete(index);
    decoded.set(index, value);
    return value;
  };

  return decode(0);
}

/**
 * A `__data.json` response is `{ "type": "data", "nodes": [...] }`: one node
 * per layout/page. With `x-sveltekit-invalidated=001` the layouts come back as
 * `{ "type": "skip" }` and the page is the last node with `type: "data"`.
 */
export function decodeSvelteKitPageData(body: unknown): unknown {
  if (body === null || typeof body !== "object" || (body as { type?: unknown }).type !== "data") {
    throw new PortalProtocolError('__data.json: expected { "type": "data", "nodes": [...] }');
  }
  const nodes = (body as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) throw new PortalProtocolError("__data.json: `nodes` is missing");
  const pageNode = [...nodes].reverse().find((node) => node !== null && typeof node === "object" && node.type === "data");
  if (pageNode === undefined) throw new PortalProtocolError("__data.json: no data node");
  return decodeDevalue((pageNode as { data?: unknown }).data);
}
