/**
 * The edge sensor's per-connection fingerprint, as delivered to the app: edge/sensor.ts puts it
 * in a PROXY-protocol v2 TLV, nginx copies that TLV into the X-HP-Edge request header
 * (proxy_params_edge.conf), and every other nginx server block blanks the header so a client
 * can never supply its own.
 */
export interface EdgeInfo {
  v: 1;
  conn: string;
  tls: boolean;
  ja4?: string;
  ja4_r?: string;
  ja3?: string;
  ja3_hash?: string;
  ja3n_hash?: string;
  hello?: {
    sni: string | null;
    alpn: string[];
    versions: number[];
    ciphers: number[];
    extensions: number[];
    groups: number[];
    sigalgs: number[];
    keyShare: number[];
    pskModes: number[];
    compressCert: number[];
    ech: boolean;
    grease: boolean;
    recordSizeLimit: number | null;
    padding: number | null;
    sessionIdLength: number;
  };
  negotiated?: { alpn: string | null; version: string | null; cipher: string | null };
  h2?: {
    fp: string;
    settings: Array<[number, number]>;
    windowUpdate: number | null;
    priority: string[];
    headersPriority: string | null;
    pseudoOrder: string | null;
  };
  h1?: { headerNames: string[] };
  timing?: { helloMs: number; handshakeMs: number | null; firstDataMs: number | null };
  error?: string;
}

export function decodeEdgeHeader(value: string | string[] | undefined): EdgeInfo | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as EdgeInfo;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}
