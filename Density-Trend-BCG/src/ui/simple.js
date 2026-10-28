// The plain-English guide shown to normal (non-administrator) users: what the numbers mean and how to use them. No technical detail.
async function pgGuideSimple(el) {
  const card = (h, body) => `<div class="card"><h3>${h}</h3>${body}</div>`;
  const row = (a, b) => `<tr><td class="b" style="white-space:nowrap">${a}</td><td>${b}</td></tr>`;
  el.innerHTML = `
  <div class="grid" style="gap:16px">
    ${card("What HiveMind does", `<p>HiveMind reads the Indian news every hour and works out <b>which subjects are suddenly getting more attention than usual</b>, which of them matter to your business, and when to act. The result is a short, ranked list of opportunities, each with the reasons behind it.</p>
      <p class="small mute" style="margin:6px 0 0">It is a guide to where to look first. It does not predict the future with certainty, and people make the final call.</p>`)}

    ${card("A ten-minute routine", `<ol style="margin:0;padding-left:20px;line-height:1.7">
      <li><b>Overview.</b> The six boxes at the top give the state of play. Under “Today’s priorities” are the best opportunities.</li>
      <li><b>Open the top one</b> by clicking it. Read “Why now”, then look at the score breakdown and the chart.</li>
      <li><b>Check the evidence.</b> Click the number of origins to see which independent sources reported it, with links.</li>
      <li><b>Act on the label:</b> <i>write now</i> means go, <i>investigate</i> means find out more first, <i>monitor</i> means watch, <i>skip</i> means leave it.</li></ol>`)}

    ${card("The numbers, in plain words", `<div class="tw" style="max-height:none"><table class="t"><tbody>
      ${row("Coverage share", "The slice of all news stories that are about this topic. 0.8% means about 8 of every 1,000 stories.")}
      ${row("Momentum", "How much bigger that slice is than normal. 1.0× is normal, 3× means three times the usual attention.")}
      ${row("Acceleration", "Whether the attention is still speeding up or starting to slow. A positive number means speeding up.")}
      ${row("Independent origins", "How many separate sources reported it. Outlets under one owner, and copies of a wire report, count once, so this is the real measure of confirmation.")}
      ${row("Stage", "Where the topic is in its life: <i>emerging</i> and <i>rising</i> are early and interesting; <i>steady</i> is normal; <i>crowded</i> means everyone is already writing about it; <i>declining</i> is fading.")}
      ${row("Evidence", "High, medium or low: how well supported it is, by independent sources and by how much history we have.")}
      ${row("Verified trigger", "A recent story confirmed by an official source or at least three independent sources: the event that gives a reason to act now.")}
    </tbody></table></div>`)}

    ${card("How the score out of 100 is made", `<p>Every opportunity is a business sector paired with a news topic. Its score adds up six things, each one visible when you open it:</p>
      <ul style="margin:0;padding-left:20px;line-height:1.7">
        <li><b>Momentum</b> (25): how far above normal the topic is.</li>
        <li><b>Acceleration</b> (15): whether it is still speeding up.</li>
        <li><b>Independent sources</b> (15): how many separate sources report it.</li>
        <li><b>Sector fit</b> (20): how much it really matters to that sector.</li>
        <li><b>Timing</b> (15): how fresh the confirming event is.</li>
        <li><b>Room for a fresh angle</b> (10): the less crowded the topic, the better.</li></ul>
      <p class="small mute" style="margin:8px 0 0">The score ranks opportunities. It is <b>not a probability</b>.</p>`)}

    ${card("What the actions mean", `<div class="tw" style="max-height:none"><table class="t"><tbody>
      ${row("Write now", "Everything lines up: strong score, solid evidence, a rising topic, room for a fresh angle, a confirmed trigger, enough history. This is rare on purpose.")}
      ${row("Investigate", "Promising, but something is still missing. The opportunity lists exactly what.")}
      ${row("Monitor", "On the watchlist: the score is low or there is too little evidence so far.")}
      ${row("Skip", "Attention is fading, the topic is crowded, or the score is weak.")}</tbody></table></div>`)}

    ${card("Reading the chart", `<p>Blue bars are the number of stories, the blue line is the topic’s share of all coverage, and the green line is a smoothed average. A diamond marks a confirmed trigger. The dashed orange area is a simple forecast with its range; it is a rough guide that has not yet been proven, so treat it with care.</p>`)}

    ${card("Things to keep in mind", `<ul style="margin:0;padding-left:20px;line-height:1.7">
      <li>The system sees the sources it is set up to follow, not the whole market.</li>
      <li>Scores are firmer as history builds. Early on they are indicative; look for the “Thin history” note.</li>
      <li>Always open the evidence before acting. If you would not trust those sources, do not trust the signal.</li>
      <li>Sentiment shows how the <i>press</i> is writing, not how the public feels.</li></ul>`)}
  </div>`;
}
