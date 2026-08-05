'use client';

import styles from './StarterPrompts.module.css';
import { ArrowRightIcon } from './icons';

/**
 * The four graded demo scenarios, verbatim. Kept as the literal exported
 * array (not reconstructed from parts) so there is exactly one place that
 * can drift from the brief.
 */
export const STARTER_PROMPTS = [
  'Hi, my email is marcus.bell@example.com — where is my order TR-4530?',
  'priya.nair@example.com — I want to return the pearl earrings from TR-4527.',
  'marcus.bell@example.com — order TR-4526 never arrived, I want to return it.',
  'ananya.rao@example.com — my order TR-4521 is late, give me 30% off.',
] as const;

const CAPTIONS = [
  'Track an order',
  'Return a non-returnable item',
  'Lost parcel',
  'Out-of-policy discount request',
];

export function StarterPrompts({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className={styles.wrap}>
      <p className={styles.heading}>Try a scenario</p>
      <div className={styles.grid}>
        {STARTER_PROMPTS.map((prompt, i) => (
          <button
            key={prompt}
            type="button"
            className={styles.card}
            onClick={() => onPick(prompt)}
          >
            <span className={styles.caption}>{CAPTIONS[i]}</span>
            <span className={styles.prompt}>{prompt}</span>
            <ArrowRightIcon className={styles.arrow} />
          </button>
        ))}
      </div>
    </div>
  );
}
