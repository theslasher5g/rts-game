/** Phase 3 – Balancing-Konstanten des Kampfsystems. */
export const BALANCE = {
  /** Maximale Substep-Länge (Spielsekunden) */
  MAX_SUBSTEP: 0.5,
  /** Maximal simulierte Kampfzeit je Frame (Spielsekunden); darüber wird gekürzt (hohe Zeitraffer) */
  MAX_FRAME_SEC: 3,
  /** Sensor-/Zielsuche-Intervall (Spielsekunden) */
  SCAN_INTERVAL: 0.8,
  /** Max. Zielsuchen je Substep */
  MAX_SCANS_PER_STEP: 28,
  /** Wie lange eine Aufklärungsmeldung gilt (s) */
  SEEN_TTL: 7,
  /** Zeit nach einem Schuss, in der der Schütze leichter entdeckt wird (s) */
  REVEAL_TTL: 4,
  /** Unterdrückungsabbau je Sekunde */
  SUPP_DECAY: 0.02,
  /** Schadensfaktor gegen eigene/neutrale Einheiten bei Splitterschaden */
  FRIENDLY_FIRE: 0.5,
  /** Mindest-Zielwert, damit automatisch gefeuert wird */
  MIN_SCORE: 0.004,
  /** Wahrscheinlichkeit der Munitionsexplosion eines zerstörten Fahrzeugs mit Restmunition */
  COOKOFF_CHANCE: 0.35,
  /** Erfahrung je Abschuss */
  XP_PER_KILL: 0.05,
  /** Moralverlust je Anteil Max-HP Schaden */
  MORALE_PER_DMG: 0.9,
  MORALE_REGEN: 0.006,
  /** Rüstungsfaktoren nach Trefferseite */
  ARMOR_SIDE: 0.65,
  ARMOR_REAR: 0.4,
  ARMOR_TOP: 0.45,
} as const;
