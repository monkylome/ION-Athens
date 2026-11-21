import type { Kind } from "./logic";

/** One hard-edged mark per kind, drawn on a 48 grid in currentColor. Decorative: the label carries the meaning. */
export function Glyph({ kind }: { kind: Kind }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 5, strokeLinejoin: "miter" as const };
  let shape;
  switch (kind) {
    case "steps": shape = <path {...stroke} d="M4 42 H16 V30 H28 V18 H40 V6" />; break;
    case "ramp": shape = <path {...stroke} d="M4 42 L44 42 L44 12 Z" />; break;
    case "sidewalk_obstacle": shape = <><path {...stroke} d="M24 4 L46 42 H2 Z" /><path {...stroke} d="M24 18 V30 M24 35 V37" /></>; break;
    case "narrow_sidewalk": shape = <path {...stroke} d="M4 6 V42 M44 6 V42 M18 14 V34 M30 14 V34" />; break;
    case "tactile_paving": shape = <>{[10, 24, 38].flatMap((x) => [10, 24, 38].map((y) => <rect key={`${x}${y}`} x={x - 5} y={y - 5} width="10" height="10" fill="currentColor" />))}</>; break;
    case "crossing_signals": shape = <><path {...stroke} d="M4 30 H44 M4 40 H44" /><rect {...stroke} x="17" y="4" width="14" height="19" /></>; break;
    case "crossing_no_signals": shape = <path {...stroke} d="M4 12 H44 M4 24 H44 M4 36 H44" />; break;
    case "entrance_step_free": shape = <><rect {...stroke} x="12" y="4" width="24" height="38" /><path {...stroke} d="M2 42 H46" /></>; break;
    case "entrance_with_steps": shape = <><rect {...stroke} x="22" y="4" width="22" height="26" /><path {...stroke} d="M2 42 H12 V36 H22 V30" /></>; break;
    case "lift": shape = <><rect {...stroke} x="8" y="4" width="32" height="40" /><path {...stroke} d="M24 12 V36 M16 20 L24 12 L32 20" /></>; break;
    case "sign_text": shape = <><rect {...stroke} x="4" y="8" width="40" height="26" /><path {...stroke} d="M12 17 H36 M12 25 H30 M24 34 V44" /></>; break;
    case "clear_path": shape = <path {...stroke} d="M18 46 V2 M30 46 V2" />; break;
  }
  return <svg className="scan__glyph" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">{shape}</svg>;
}
