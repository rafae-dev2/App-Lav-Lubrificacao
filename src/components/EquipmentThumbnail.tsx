import {getEquipmentImageRevision,subscribeEquipmentImageChanges} from '../lib/equipmentImageRegistry';
import { useEffect, useState, useSyncExternalStore } from "react";
import { resolveEquipmentImage } from "../lib/equipmentImages";
import "../styles/equipment-images.css";

type EquipmentThumbnailSize = "card" | "table" | "hero";

export interface EquipmentThumbnailProps {
  equipment: unknown;
  size?: EquipmentThumbnailSize;
  className?: string;
}

const imageTitle = "Tipo ilustrativo; não é foto da frota atual";

export default function EquipmentThumbnail({
  equipment,
  size = "card",
  className = "",
}: EquipmentThumbnailProps) {
  useSyncExternalStore(subscribeEquipmentImageChanges,getEquipmentImageRevision,()=>0);
  const resolved = resolveEquipmentImage(equipment);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = resolved?.src || null;
  const failed = Boolean(source && failedSource === source);

  useEffect(() => {
    setFailedSource((current) => (current && current !== source ? null : current));
  }, [source]);

  if (!resolved) return null;

  const classes = [
    "equipment-thumbnail",
    `equipment-thumbnail--${size}`,
    failed ? "equipment-thumbnail--failed" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      data-equipment-key={resolved.key}
      data-size={size}
      title={imageTitle}
      aria-label={`Ilustração de tipo: ${resolved.label}`}
      role="img"
    >
      {failed ? (
        <span className="equipment-thumbnail__fallback" aria-hidden="true" />
      ) : (
        <img
          src={resolved.src}
          alt={`Ilustração de tipo: ${resolved.label}`}
          title={imageTitle}
          crossOrigin={resolved.src.startsWith('https://') ? 'anonymous' : undefined}
      loading="lazy"
          decoding="async"
          width={400}
          height={225}
          onError={(event) => {
            setFailedSource(event.currentTarget.src || resolved.src);
          }}
          onLoad={() => setFailedSource((current) => (current === resolved.src ? null : current))}
        />
      )}
    </span>
  );
}
