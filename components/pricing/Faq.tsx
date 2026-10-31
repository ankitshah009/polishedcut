import { ChevronDown } from "lucide-react";

const QA: { q: string; a: string }[] = [
  {
    q: "What counts as a cut?",
    a: "One brief plus its footage, run through the loop until it passes or hits three versions. Fixes inside that loop are part of the same cut. A director's note after the fact starts a new version but not a new cut.",
  },
  {
    q: "Why does a cut cost more when Argon fixes it?",
    a: "Every version Argon watches is another look at the rendered video. Transcription and rendering are paid once; watching is paid per version. That is why the estimate on a cut grows with the number of versions.",
  },
  {
    q: "Is the cost shown in the editor exact?",
    a: "It is an estimate from the tokens Argon reported and the list rate for each model. Google bills your key directly; the AI Studio usage page has the final number.",
  },
  {
    q: "Can I bring my own Gemini key?",
    a: "Yes, on Pay as you go. PolishedTake then meters tokens for you and never marks them up; you pay Google for the models and us for the editor.",
  },
  {
    q: "What happens when I run out of cuts?",
    a: "Finished cuts stay in your library and still export. New cuts wait until the next month, or you switch plans at any point in the month and the difference is prorated.",
  },
  {
    q: "Do unused cuts roll over?",
    a: "No. Plans reset on the first of each month. If your volume swings a lot, Pay as you go is usually the cheaper fit.",
  },
];

/** Plain details/summary, so it works without JavaScript and reads naturally to screen readers. */
export function Faq() {
  return (
    <section aria-labelledby="faq-heading" className="mt-20 grid gap-8 border-t pt-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <h2 id="faq-heading" className="font-serif text-3xl tracking-tight">
        Questions, answered
      </h2>
      <div className="divide-y rounded-2xl border bg-card shadow-tile">
        {QA.map(({ q, a }) => (
          <details key={q} className="group px-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left text-[15px] font-medium marker:content-none [&::-webkit-details-marker]:hidden">
              <h3 className="text-[15px] font-medium">{q}</h3>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="pb-5 text-sm leading-relaxed text-muted-foreground">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
