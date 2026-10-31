"use client";

import { Receipt } from "lucide-react";
import Link from "next/link";

import { formatTokens, formatUsd, type Rates } from "@/lib/format";

export interface ExampleCut {
  id: string;
  brief: string;
  usd: number;
  tokens: number;
  iterations: number;
  /** Per-model split when the estimate was made on the client; null when the server supplied the total. */
  byModel: { model: string; usd: number; tokens: number }[] | null;
}

const DEFAULT_ASSUMPTIONS = [
  "A cut sends every clip to Argon once to draft, then the rendered video once per version to watch.",
  "Most cuts finish in one or two versions; a third version is the cap.",
  "Transcription and rendering are fixed costs that do not grow with fixes.",
  "Estimates use list prices per million tokens and ignore free-tier allowances.",
];

const perM = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

/** "What a cut costs us": per-model rates, a worked example from a real run, and the assumptions behind both. */
export function CostPanel({ rates, assumptions, example }: { rates: Rates | null; assumptions: string[]; example: ExampleCut | null | undefined }) {
  const notes = assumptions.length ? assumptions : DEFAULT_ASSUMPTIONS;
  return (
    <section aria-labelledby="cost-heading" className="mt-20 grid gap-8 border-t pt-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <h2 id="cost-heading" className="font-serif text-3xl tracking-tight">
          What a cut costs us
        </h2>
        <p className="mt-3 max-w-[48ch] leading-relaxed text-muted-foreground">
          Plans are priced from the model time behind them. These are the per-model rates we pay, and a real cut from
          this workspace priced at those rates.
        </p>
        <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
          {notes.map((a) => (
            <li key={a} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-amber" aria-hidden />
              {a}
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-1 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Rates */}
        <div className="rounded-2xl border bg-card p-5 shadow-tile">
          <h3 className="text-sm font-medium">Per-model rates</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">USD per million tokens</p>
          {rates ? (
            <>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-normal">Model</th>
                  <th className="pb-2 pl-3 text-right font-normal">Input</th>
                  <th className="pb-2 pl-3 text-right font-normal">Output</th>
                  <th className="pb-2 pl-3 text-right font-normal">Cached</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(rates).map(([model, r]) => (
                  <tr key={model} title={r.note}>
                    <td className="py-2 pr-3">
                      <span className="font-tc text-xs">{model}</span>
                      {r.source === "assumed" && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">assumed</span>}
                    </td>
                    {r.perCall ? (
                      <td colSpan={3} className="font-tc py-2 pl-3 text-right text-muted-foreground">
                        {perM(r.perCall)} per call
                      </td>
                    ) : (
                      <>
                        <td className="font-tc py-2 pl-3 text-right">{perM(r.input)}</td>
                        <td className="font-tc py-2 pl-3 text-right">{perM(r.output)}</td>
                        <td className="font-tc py-2 pl-3 text-right text-muted-foreground">{r.cached != null ? perM(r.cached) : "–"}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">“Assumed” rates are not published for that model yet; hover a row for the note.</p>
            </>
          ) : (
            <div className="mt-4 space-y-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-5 animate-pulse rounded bg-muted" />
              ))}
            </div>
          )}
        </div>

        {/* Example */}
        <div className="rounded-2xl border bg-card p-5 shadow-tile">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Receipt className="size-4 text-amber" aria-hidden /> Your latest cut, priced
          </h3>
          {example === undefined ? (
            <div className="mt-4 space-y-2" aria-hidden>
              <div className="h-8 w-28 animate-pulse rounded bg-muted" />
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            </div>
          ) : example === null ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No cut has reported its token usage yet. Finish one and the real number lands here.
            </p>
          ) : (
            <>
              <p className="mt-3 flex items-baseline gap-2">
                <span className="font-tc text-3xl font-semibold tracking-tight">≈ {formatUsd(example.usd)}</span>
                <span className="font-tc text-sm whitespace-nowrap text-muted-foreground">{formatTokens(example.tokens)} tokens</span>
              </p>
              {example.iterations > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {example.iterations} version{example.iterations === 1 ? "" : "s"} ·{" "}
                  {example.iterations > 1 ? `${example.iterations - 1} fix${example.iterations > 2 ? "es" : ""}` : "passed first time"}
                </p>
              )}
              {example.byModel && example.byModel.length > 0 && (
                <ul className="mt-3 divide-y text-sm">
                  {example.byModel.map((m) => (
                    <li key={m.model} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="font-tc min-w-0 truncate text-xs">{m.model}</span>
                      <span className="font-tc shrink-0 text-xs text-muted-foreground">
                        {formatTokens(m.tokens)} · {formatUsd(m.usd)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link href={`/runs/${example.id}`} className="mt-4 block truncate text-xs text-muted-foreground hover:text-foreground" title={example.brief}>
                “{example.brief}”
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
