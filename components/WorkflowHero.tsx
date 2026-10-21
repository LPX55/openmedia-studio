export function WorkflowHero() {
  return (
    <section
      className="relative w-full py-8 md:py-11"
      style={{ overflowX: "clip", overflowY: "visible" }}
    >
      <style>{`
        @keyframes hero-fade-up {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hero-label {
          animation: hero-fade-up 0.5s cubic-bezier(.22,1,.36,1) 0.08s both;
        }
        .hero-title {
          animation: hero-fade-up 0.6s cubic-bezier(.22,1,.36,1) 0.2s both;
        }
        .hero-side {
          animation: hero-fade-up 0.65s cubic-bezier(.22,1,.36,1) 0.3s both;
        }
      `}</style>

      {/* Ambient radial glow matching dark canvas tokens */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-[240px] w-[min(860px,92vw)] -translate-y-1/2"
        style={{
          background:
            "radial-gradient(ellipse 60% 55% at 50% 50%, rgba(45,212,191,0.10) 0%, rgba(34,211,238,0.04) 45%, transparent 75%)",
        }}
      />

      <div className="relative mx-auto flex max-w-[1160px] flex-col items-center justify-center px-6">
        <div className="relative flex w-full items-center justify-center lg:justify-between">
          {/* Desktop bezier connectors */}
          <svg
            className="pointer-events-none absolute inset-0 hidden size-full lg:block"
            viewBox="0 0 1160 180"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="hero-edge-left" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0.55" />
              </linearGradient>
              <linearGradient id="hero-edge-right" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.22" />
              </linearGradient>
            </defs>
            <path
              d="M 224 90 C 290 90, 300 90, 355 90"
              stroke="url(#hero-edge-left)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d="M 805 90 C 860 90, 870 90, 936 90"
              stroke="url(#hero-edge-right)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Left node: Prompt input card */}
          <div className="hero-side relative z-[2] hidden w-[224px] shrink-0 select-none lg:block">
            <div className="flex items-center">
              <div
                className="w-full rounded-[8px] border border-[#1C2436] bg-[#141820]/90 shadow-[0_2px_16px_rgba(0,0,0,0.5)] backdrop-blur-sm"
              >
                <div className="flex items-center justify-between border-b border-[#1C2436] px-2.5 py-1.5">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.04em] text-[#A0A0A0] uppercase">
                    <span className="size-1.5 rounded-full bg-[#2DD4BF]" />
                    Prompt
                  </span>
                  <span className="font-mono text-[9px] text-[#6A7080]">IN</span>
                </div>
                <div className="p-2">
                  <div className="rounded-[5px] border border-[#1A2030] bg-[#0D1119] px-2.5 py-2">
                    <p className="text-[11px] leading-[1.45] text-white/65">
                      Generate AI images and videos with customizable workflows. Connect nodes and set parameters.
                    </p>
                  </div>
                </div>
              </div>
              <span
                className="-ml-[5px] size-2.5 shrink-0 rounded-full border-2 border-[#0B0E14] bg-[#2DD4BF] shadow-[0_0_8px_rgba(45,212,191,0.5)]"
                aria-hidden="true"
              />
            </div>
          </div>

          {/* Central hero node */}
          <div className="relative z-[5] select-none">
            <div className="flex items-center">
              <span
                className="-mr-[5px] z-10 size-2.5 shrink-0 rounded-full border-2 border-[#0B0E14] bg-[#2DD4BF] shadow-[0_0_8px_rgba(45,212,191,0.5)]"
                aria-hidden="true"
              />
              <div
                className="relative flex w-[min(450px,calc(100vw-48px))] flex-col items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-[#2DD4BF] bg-[#141820]/75 px-6 py-5 text-center backdrop-blur-sm"
                style={{
                  boxShadow:
                    "0 0 0 1px rgba(45, 212, 191, 0.22), 0 8px 32px rgba(0, 15, 30, 0.55)",
                }}
              >
                <p
                  className="hero-label font-mono text-[13px] leading-5 font-bold tracking-[0.08em] uppercase bg-clip-text text-transparent whitespace-nowrap"
                  style={{
                    backgroundImage:
                      "linear-gradient(to right, rgba(255,255,255,0.45), rgba(45,212,191,0.95), rgba(255,255,255,0.45))",
                  }}
                >
                  OpenMedia Studio
                </p>
                <h1 className="hero-title text-[28px] leading-[32px] font-bold tracking-[-1.1px] text-white uppercase md:text-[38px] md:leading-[40px] md:tracking-[-1.5px]">
                  Build AI workflows
                  <br />
                  and generate media
                </h1>
              </div>
              <span
                className="-ml-[5px] z-10 size-2.5 shrink-0 rounded-full border-2 border-[#0B0E14] bg-[#22d3ee] shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                aria-hidden="true"
              />
            </div>
          </div>

          {/* Right node: Output card */}
          <div className="hero-side relative z-[2] hidden w-[224px] shrink-0 select-none lg:block">
            <div className="flex items-center">
              <span
                className="-mr-[5px] z-10 size-2.5 shrink-0 rounded-full border-2 border-[#0B0E14] bg-[#22d3ee] shadow-[0_0_8px_rgba(34,211,238,0.5)]"
                aria-hidden="true"
              />
              <div
                className="w-full rounded-[8px] border border-[#1C2436] bg-[#141820]/90 shadow-[0_2px_16px_rgba(0,0,0,0.5)] backdrop-blur-sm"
              >
                <div className="flex items-center justify-between border-b border-[#1C2436] px-2.5 py-1.5">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.04em] text-[#A0A0A0] uppercase">
                    <span className="size-1.5 rounded-full bg-[#22d3ee]" />
                    Media Output
                  </span>
                  <span className="font-mono text-[9px] text-[#6A7080]">OUT</span>
                </div>
                <div className="p-2">
                  <div
                    className="flex flex-col justify-between rounded-[5px] border border-[#1A2030] p-2.5"
                    style={{
                      background:
                        "radial-gradient(circle at 22% 20%, rgba(45,212,191,0.16) 0%, rgba(34,211,238,0.07) 48%, #0D1119 100%)",
                      minHeight: "66px",
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="rounded border border-[#2DD4BF]/30 bg-[#2DD4BF]/10 px-1.5 py-0.5 font-mono text-[9px] font-medium text-[#2DD4BF] uppercase">
                        Image
                      </span>
                      <span className="rounded border border-[#22d3ee]/30 bg-[#22d3ee]/10 px-1.5 py-0.5 font-mono text-[9px] font-medium text-[#22d3ee] uppercase">
                        Video
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-[10px] tracking-[0.02em] text-[#A0A0A0]">
                      Multi-node canvas pipeline
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Subtitle on compact screens where flanking nodes are hidden */}
        <p className="mt-3 max-w-[420px] text-center text-[13px] leading-relaxed text-white/55 lg:hidden">
          Generate AI images and videos with customizable workflows. Connect nodes and set parameters.
        </p>
      </div>
    </section>
  );
}
