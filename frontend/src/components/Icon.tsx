// Filenames live in frontend/public/icons/*.png (Fugue, CC BY 3.0).
const ICONS = {
  chart: "chart-up",
  table: "table",
  flag: "flag-red",
  gear: "gear",
  money: "money-coin",
  transfer: "arrow-switch",
  cross: "cross",
  tick: "tick",
  alert: "exclamation",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, alt = "" }: { name: IconName; size?: number; alt?: string }) {
  return (
    <img
      className="icon"
      src={`/icons/${ICONS[name]}.png`}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === "" ? "true" : undefined}
    />
  );
}
