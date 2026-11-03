import { NETWORK_LEVELS, NODE_SEPARATOR, type Meter, type MeterStatus, type NetworkLevel } from "./meter.js";

export interface NetworkNode {
  /**
   * The node's path from the zone down, e.g. "Z-01.C-01.D-07". Codes repeat
   * under different parents, so the path (not the code) is the identity.
   */
  readonly id: string;
  readonly level: NetworkLevel;
  readonly code: string;
  readonly name: string;
  readonly meterCount: number;
  readonly statusCounts: Readonly<Partial<Record<MeterStatus, number>>>;
  readonly children: readonly NetworkNode[];
}

export interface NetworkTree {
  readonly roots: readonly NetworkNode[];
  readonly byId: ReadonlyMap<string, NetworkNode>;
}

interface MutableNode {
  id: string;
  level: NetworkLevel;
  code: string;
  names: Map<string, number>;
  meterCount: number;
  statusCounts: Partial<Record<MeterStatus, number>>;
  children: Map<string, MutableNode>;
}

/**
 * Zone > Circle > Division > Subdivision > Substation > Feeder > Transformer,
 * built from the meters themselves, with meter and status counts per node.
 *
 * The scan showed every transformer has exactly one path above it, so walking
 * each meter's path yields a proper tree. If the portal ever breaks that, a
 * transformer simply appears under two parents (visible, not hidden).
 */
export function buildNetworkTree(meters: readonly Meter[]): NetworkTree {
  const roots = new Map<string, MutableNode>();

  for (const meter of meters) {
    let siblings = roots;
    let path = "";
    for (const level of NETWORK_LEVELS) {
      const { code, name } = meter.network[level];
      path = path === "" ? code || "?" : `${path}${NODE_SEPARATOR}${code || "?"}`;
      let node = siblings.get(path);
      if (node === undefined) {
        node = { id: path, level, code, names: new Map(), meterCount: 0, statusCounts: {}, children: new Map() };
        siblings.set(path, node);
      }
      if (name !== "") node.names.set(name, (node.names.get(name) ?? 0) + 1);
      node.meterCount += 1;
      node.statusCounts[meter.status] = (node.statusCounts[meter.status] ?? 0) + 1;
      siblings = node.children;
    }
  }

  const byId = new Map<string, NetworkNode>();
  const freeze = (node: MutableNode): NetworkNode => {
    const frozen: NetworkNode = {
      id: node.id,
      level: node.level,
      code: node.code,
      name: [...node.names.entries()].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))[0]?.[0] ?? "",
      meterCount: node.meterCount,
      statusCounts: node.statusCounts,
      children: sortNodes([...node.children.values()].map(freeze)),
    };
    byId.set(frozen.id, frozen);
    return frozen;
  };

  return { roots: sortNodes([...roots.values()].map(freeze)), byId };
}

function sortNodes(nodes: NetworkNode[]): NetworkNode[] {
  return nodes.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}
