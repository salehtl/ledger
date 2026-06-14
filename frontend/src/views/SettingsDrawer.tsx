export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  return <div className="drawer-backdrop" onClick={onClose} />;
}
