/**
 * DripBag — 顶栏 Drip 开关的输液袋图标。
 *
 * Ported from the standalone page at E:/dd/1.html, the same one-shot port the
 * WhaleBun avatar came from: the bag with its hanger, the liquid that rises to
 * the fill line when the switch turns on, the wave that keeps crossing the
 * surface and the bubbles that keep leaving the outlet. The animation itself
 * lives in shared.css, keyed off the button's `aria-pressed` — on fills, off
 * drains.
 *
 * Two deliberate departures from the source drawing, both forced by the size
 * the icon is drawn at (~20px inside a 26px button):
 *
 * - The viewBox is cropped to the bag itself (x 56–569, y 51–782 of the
 *   original 671×1074 canvas). The tubes, clamp and regulator below are the
 *   first things that size cannot afford, and the label's text lines would be
 *   a smudge — the label patch stays.
 * - The black line art draws in `currentColor` (black would vanish on the
 *   dark bar) with `non-scaling-stroke`, so the ~1px line weight survives a
 *   550-unit viewBox squeezed into 20px. The wave's amplitude is deepened
 *   (11 → 37 units) for the same reason: at 1/25 scale the original ripple is
 *   sub-pixel, this one stays a visible shimmer.
 */
export function DripBagIcon() {
  return (
    <svg viewBox="40 30 550 770" aria-hidden className="mon-drip__icon">
      <defs>
        <linearGradient id="mon-drip-liquid-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9d9f9" />
          <stop offset="1" stopColor="#4f97dd" />
        </linearGradient>
        <clipPath id="mon-drip-inner-clip">
          <path d="M120 151
            C149 132 180 133 213 147
            C284 177 389 176 459 147
            C490 134 519 135 539 154
            C553 168 555 191 553 227
            L536 651
            C534 691 505 720 461 737
            C384 765 294 765 207 739
            C166 727 139 698 137 656
            L119 228
            C117 194 111 168 120 151Z" />
        </clipPath>
      </defs>

      {/* The liquid, clipped to the bag's interior: parked below the bag while
          the switch is off, risen to the fill line (y=342) while it is on. */}
      <g clipPath="url(#mon-drip-inner-clip)">
        <g className="mon-drip__liquid">
          <g className="mon-drip__wave">
            <path
              fill="url(#mon-drip-liquid-grad)"
              opacity="0.9"
              d="M-140 342
                Q-125 305 -110 342 T-80 342 T-50 342 T-20 342 T10 342 T40 342
                T70 342 T100 342 T130 342 T160 342 T190 342 T220 342 T250 342
                T280 342 T310 342 T340 342 T370 342 T400 342 T430 342 T460 342
                T490 342 T520 342 T550 342 T580 342 T610 342 T640 342 T670 342
                L670 900 L-140 900Z"
            />
            <path
              className="mon-drip__wave-line"
              vectorEffect="non-scaling-stroke"
              fill="none"
              stroke="#3d85c6"
              strokeWidth="1.2"
              strokeLinecap="round"
              d="M-140 342
                Q-125 305 -110 342 T-80 342 T-50 342 T-20 342 T10 342 T40 342
                T70 342 T100 342 T130 342 T160 342 T190 342 T220 342 T250 342
                T280 342 T310 342 T340 342 T370 342 T400 342 T430 342 T460 342
                T490 342 T520 342 T550 342 T580 342 T610 342 T640 342 T670 342"
            />
          </g>
          {/* Bubbles leave the outlet while filled, staggered so they never
              move in step. */}
          <g
            className="mon-drip__bubbles"
            fill="#dff1fd"
            stroke="#b5dcf5"
            strokeWidth="1"
          >
            <circle cx="240" cy="748" r="44" vectorEffect="non-scaling-stroke" />
            <circle cx="385" cy="760" r="50" vectorEffect="non-scaling-stroke" />
            <circle cx="495" cy="738" r="40" vectorEffect="non-scaling-stroke" />
          </g>
        </g>
      </g>

      {/* The line art, in currentColor: bag outline, hanger, label patch. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          vectorEffect="non-scaling-stroke"
          d="M247 51
            C267 51 278 51 292 51
            C313 51 335 51 354 51
            C375 51 387 52 404 63
            C426 78 445 83 479 85
            C533 88 566 111 569 159
            L551 657
            C549 700 530 730 492 750
            L451 772
            C438 779 424 782 410 782
            L205 782
            C191 782 178 779 166 772
            L133 751
            C95 729 75 699 73 657
            L58 184
            C56 134 77 99 119 87
            C141 81 167 84 193 82
            C216 80 231 69 247 51Z"
        />
        <circle cx="315" cy="97" r="22" vectorEffect="non-scaling-stroke" />
        <rect x="151" y="246" width="304" height="303" rx="14" vectorEffect="non-scaling-stroke" />
      </g>

      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* The bag's inner wall, which is also the liquid's clip. */}
        <path
          vectorEffect="non-scaling-stroke"
          d="M120 151
            C149 132 180 133 213 147
            C284 177 389 176 459 147
            C490 134 519 135 539 154
            C553 168 555 191 553 227
            L536 651
            C534 691 505 720 461 737
            C384 765 294 765 207 739
            C166 727 139 698 137 656
            L119 228
            C117 194 111 168 120 151Z"
        />
      </g>
    </svg>
  );
}
