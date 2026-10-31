import Link from "next/link";
import PipelineExplainer from "@/components/how/PipelineExplainer";
import { stackStatus } from "@/lib/stack";

export const metadata = { title: "How PolishedTake works" };
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HowPage() {
  const stack = await stackStatus();
  return (
    <div className="flex-1 overflow-y-auto bg-bg text-fg">
      <div className="mx-auto max-w-[1100px] px-4 pb-24 pt-10 sm:px-8">
        <Link href="/" className="text-sm text-dim hover:text-fg focus-visible:text-fg">
          Back to the editor
        </Link>
        <h1 className="mt-6 max-w-[16ch] font-serif text-[clamp(36px,5.5vw,64px)] leading-[1.02] tracking-tight">
          An editor that watches its own cut
        </h1>
        <p className="mt-5 max-w-[62ch] text-[17px] leading-relaxed text-dim">
          Argon drafts an edit, ffmpeg renders it, then Argon watches the rendered video, grades it against your brief
          with timestamped checks, and patches what failed. The loop runs up to three versions. Click a stage to see the
          data it hands to the next one.
        </p>

        <PipelineExplainer />

        <section className="mt-20 grid gap-10 border-t border-line pt-10 md:grid-cols-[220px_1fr]">
          <div>
            <h2 className="font-serif text-2xl">What runs where</h2>
            <p className="mt-3 text-sm leading-relaxed text-dim">
              Seven Google models and ffmpeg. Model ids come straight from the code; the evidence comes from the cuts
              on this machine.
            </p>
          </div>
          <dl className="divide-y divide-line">
            {stack.map((m) => (
              <div key={m.name} className="grid gap-2 py-5 sm:grid-cols-[240px_1fr]">
                <dt>
                  <span className="block font-medium text-fg">{m.name}</span>
                  <span className="mt-1 block text-xs text-faint">{m.stage}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {m.models.map((id) => (
                      <code key={id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-amber">
                        {id}
                      </code>
                    ))}
                  </span>
                </dt>
                <dd className="text-dim">
                  <p className="leading-relaxed">{m.role}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {m.evidence ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-success">
                        <span className="size-1.5 rounded-full bg-success" />
                        {m.evidence}
                      </span>
                    ) : m.name.startsWith("Gemini 3.8 Live") ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-accent-foreground">
                        Live sessions run in your browser and are not stored · try it from any cut&apos;s editor
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2.5 py-1 text-faint">Not used in a cut on this machine yet</span>
                    )}
                    {m.calls > 0 && <span className="text-faint">{m.calls.toLocaleString()} metered calls</span>}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-16 grid gap-10 border-t border-line pt-10 md:grid-cols-[220px_1fr]">
          <h2 className="font-serif text-2xl">What a cut costs</h2>
          <div className="max-w-[62ch] text-dim">
            <p className="leading-relaxed">
              Every version Argon watches is a model call, so a cut that passes first time costs less than one that
              needs two fixes. The editor shows the estimate on each finished cut, and the pricing page breaks it down
              by model.
            </p>
            <Link
              href="/pricing"
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:brightness-105"
            >
              See plans and per-model rates
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
