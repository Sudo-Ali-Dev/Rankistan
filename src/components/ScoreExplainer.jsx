import React from 'react';
import { SCORE_INTRO, SCORE_PARTS, SCORE_EXAMPLE } from '../utils/score-explainer.js';

// The score explained step by step, with a worked example the model itself scored. Shared by
// About and Evolution so both pages explain it the same way.
export default function ScoreExplainer() {
  const { story, rows, score } = SCORE_EXAMPLE;
  return (
    <div className="space-y-4">
      <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed">
        {SCORE_INTRO}
      </p>

      <ol className="space-y-3">
        {SCORE_PARTS.map((part, i) => (
          <li key={part.name} className="border border-outline-variant/50 bg-surface p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="font-mono text-[10px] text-on-primary bg-primary px-2 py-0.5">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="font-headline text-sm font-bold text-on-surface">{part.name}</span>
              <span className="font-mono text-xs text-primary bg-primary/10 px-2 py-0.5">
                up to {part.points} points
              </span>
            </div>
            <p className="font-body text-xs sm:text-sm text-on-surface font-medium mb-2">
              {part.question}
            </p>
            <ul className="space-y-1.5">
              {part.lines.map((line) => (
                <li
                  key={line}
                  className="font-body text-xs text-outline leading-relaxed flex gap-2"
                >
                  <span className="text-primary shrink-0" aria-hidden="true">
                    ›
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 overflow-x-auto">
              <table className="font-mono text-xs border border-outline-variant/50">
                <tbody>
                  {part.table.head.map((label, row) => (
                    <tr
                      key={label}
                      className={row === 0 ? 'border-b border-outline-variant/50' : ''}
                    >
                      <th
                        scope="row"
                        className="px-2 py-1 text-left font-normal text-outline whitespace-nowrap"
                      >
                        {label}
                      </th>
                      {part.table.rows.map((cells) => (
                        <td
                          key={cells[0]}
                          className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${row === 0 ? 'text-on-surface' : 'text-tertiary'}`}
                        >
                          {cells[row]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 font-body text-xs text-outline leading-relaxed">{part.after}</p>
          </li>
        ))}
      </ol>

      <div className="border border-tertiary/40 bg-tertiary/5 p-3 sm:p-4">
        <span className="font-mono text-[10px] text-tertiary uppercase tracking-widest block mb-2">
          An example
        </span>
        <p className="font-body text-xs sm:text-sm text-on-surface-variant leading-relaxed mb-3">
          {story}
        </p>
        <table className="w-full font-mono text-xs">
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-outline-variant/30">
                <td className="py-1.5 pr-2 text-on-surface">{row.name}</td>
                <td className="py-1.5 pr-2 text-outline">{row.why}</td>
                <td className="py-1.5 text-right text-tertiary">+{row.points}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-2 pr-2 font-bold text-on-surface">Score</td>
              <td className="pt-2 pr-2 text-outline">
                {rows.map((row) => row.points).join(' + ')}
              </td>
              <td className="pt-2 text-right font-bold text-tertiary">{score}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
