import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

// Public landing page shown at "/" for signed-out visitors (see main.tsx Root).
// Styles are scoped under .wp-landing so they never touch the app's own styles.css
// (that file already defines .row / .btn / .total with different rules).
const CSS = `
.wp-landing{
  --ink:#131c26; --ink-soft:#43525f; --ink-faint:#7c8894; --paper:#ffffff; --surface:#edf1f4;
  --rule:#c7d0d8; --rule-soft:#dee5ea; --petrol:#1a5a7c; --brick:#a63e26;
  --serif:"Source Serif 4",Georgia,serif; --sans:"Archivo",system-ui,-apple-system,sans-serif; --measure:34rem;
  background:var(--paper); color:var(--ink); font-family:var(--serif); font-size:1.0625rem; line-height:1.62; font-weight:400;
}
.wp-landing *{box-sizing:border-box}
.wp-landing h1,.wp-landing h2,.wp-landing h3{margin:0;font-weight:600;line-height:1.16;letter-spacing:-0.015em}
.wp-landing p{margin:0 0 1.05em}
.wp-landing p:last-child{margin-bottom:0}
.wp-landing a{color:var(--petrol);text-decoration:none;border-bottom:1px solid rgba(26,90,124,.35)}
.wp-landing a:hover{border-bottom-color:var(--petrol)}
.wp-landing a:focus-visible,.wp-landing button:focus-visible{outline:2px solid var(--petrol);outline-offset:3px;border-radius:2px}
.wp-landing .wrap{max-width:62rem;margin:0 auto;padding:0 1.6rem}
.wp-landing .masthead{border-bottom:1px solid var(--rule);padding:1.4rem 0}
.wp-landing .masthead .wrap{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.wp-landing .mark{font-family:var(--sans);font-weight:600;font-size:1.02rem;letter-spacing:.005em}
.wp-landing .mark span{color:var(--petrol)}
.wp-landing .masthead .meta{font-family:var(--sans);font-size:.84rem;color:var(--ink-faint);font-weight:400}
.wp-landing .masthead-right{display:flex;align-items:baseline;gap:1.4rem;flex-wrap:wrap}
.wp-landing .login-link{font-family:var(--sans);font-size:.84rem;font-weight:500;color:var(--petrol);border-bottom:1px solid rgba(26,90,124,.35);white-space:nowrap}
.wp-landing .login-link:hover{border-bottom-color:var(--petrol)}
.wp-landing .hero{padding:4.4rem 0 3.6rem;border-bottom:1px solid var(--rule)}
.wp-landing .hero-grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);gap:4rem;align-items:start}
.wp-landing .hero h1{font-size:clamp(2.15rem,4.6vw,3.15rem);margin-bottom:1.5rem;max-width:15ch}
.wp-landing .lede{font-size:1.15rem;color:var(--ink-soft);max-width:var(--measure)}
.wp-landing .lede strong{font-weight:600;color:var(--ink)}
.wp-landing .hero-cta{margin-top:2.1rem;display:flex;gap:1.6rem;align-items:center;flex-wrap:wrap}
.wp-landing .wbtn{display:inline-block;font-family:var(--sans);font-weight:500;font-size:.95rem;background:var(--ink);color:var(--paper);padding:.72rem 1.35rem;border:1px solid var(--ink);border-radius:2px}
.wp-landing .wbtn:hover{background:var(--petrol);border-color:var(--petrol)}
.wp-landing .hero-cta .aside{font-family:var(--sans);font-size:.88rem;color:var(--ink-faint)}
.wp-landing .ledger{background:var(--surface);border:1px solid var(--rule);border-radius:2px;padding:1.5rem 1.5rem 1.35rem;font-family:var(--sans);font-variant-numeric:tabular-nums}
.wp-landing .ledger-head{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;padding-bottom:.7rem;margin-bottom:.35rem;border-bottom:1px solid var(--rule)}
.wp-landing .ledger-head .t{font-weight:600;font-size:.94rem}
.wp-landing .ledger-head .d{font-size:.8rem;color:var(--ink-faint)}
.wp-landing .wrow{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:.46rem 0;font-size:.9rem;border-bottom:1px solid var(--rule-soft)}
.wp-landing .wrow .src{color:var(--ink-soft);display:flex;align-items:baseline;gap:.5rem;min-width:0;flex-wrap:wrap}
.wp-landing .wrow .src em{font-style:normal;font-size:.74rem;color:var(--ink-faint);white-space:nowrap}
.wp-landing .wrow .amt{font-weight:500;white-space:nowrap}
.wp-landing .wrow.flagged .src{color:var(--brick)}
.wp-landing .wrow.flagged .amt{color:var(--brick)}
.wp-landing .wtotal{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-top:.8rem;padding-top:.7rem;border-top:2px solid var(--ink);font-size:1rem;font-weight:600}
.wp-landing .ledger-note{margin-top:.85rem;font-size:.78rem;line-height:1.5;color:var(--ink-faint)}
.wp-landing .anim .wrow,.wp-landing .anim .wtotal{opacity:0;transform:translateY(5px)}
.wp-landing .anim.go .wrow,.wp-landing .anim.go .wtotal{opacity:1;transform:none;transition:opacity .34s ease,transform .34s ease}
.wp-landing section{padding:3.6rem 0;border-bottom:1px solid var(--rule)}
.wp-landing .shead{font-family:var(--sans);font-size:.82rem;font-weight:500;color:var(--petrol);padding-bottom:.55rem;margin-bottom:1.6rem;border-bottom:1px solid var(--rule)}
.wp-landing h2{font-size:clamp(1.5rem,2.7vw,1.95rem);margin-bottom:1.1rem;max-width:22ch}
.wp-landing .body{max-width:var(--measure)}
.wp-landing .body.wide{max-width:44rem}
.wp-landing .cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2.6rem 3.2rem}
.wp-landing .cols h3{font-size:1.1rem;margin-bottom:.5rem}
.wp-landing .cols p{font-size:1rem;color:var(--ink-soft)}
.wp-landing ol.steps{margin:0;padding:0;list-style:none;counter-reset:s}
.wp-landing ol.steps li{counter-increment:s;position:relative;padding-left:2.4rem;margin-bottom:1.3rem;max-width:var(--measure)}
.wp-landing ol.steps li:last-child{margin-bottom:0}
.wp-landing ol.steps li::before{content:counter(s);position:absolute;left:0;top:.18rem;font-family:var(--sans);font-size:.78rem;font-weight:600;color:var(--petrol);width:1.55rem;height:1.55rem;border:1px solid var(--rule);border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--paper)}
.wp-landing ol.steps h3{font-size:1.02rem;margin-bottom:.25rem}
.wp-landing ol.steps p{font-size:.98rem;color:var(--ink-soft);margin-bottom:0}
.wp-landing ul.plain{margin:0 0 1.05em;padding:0;list-style:none;max-width:var(--measure)}
.wp-landing ul.plain li{padding-left:1.15rem;position:relative;margin-bottom:.5rem;color:var(--ink-soft)}
.wp-landing ul.plain li::before{content:"";position:absolute;left:0;top:.72em;width:.42rem;height:1px;background:var(--rule)}
.wp-landing ul.plain li:last-child{margin-bottom:0}
.wp-landing .terms{width:100%;border-collapse:collapse;max-width:44rem;margin-top:.4rem}
.wp-landing .terms th,.wp-landing .terms td{text-align:left;padding:.78rem 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
.wp-landing .terms th{font-family:var(--sans);font-size:.85rem;font-weight:500;color:var(--ink-faint);width:11rem;padding-right:1.5rem}
.wp-landing .terms td{font-size:1rem;color:var(--ink)}
.wp-landing .terms tr:last-child th,.wp-landing .terms tr:last-child td{border-bottom:none}
.wp-landing .callout{border-left:3px solid var(--petrol);background:var(--surface);padding:1.1rem 1.3rem;margin-top:1.8rem;max-width:44rem;border-radius:0 2px 2px 0}
.wp-landing .callout p{font-size:.99rem;color:var(--ink-soft)}
.wp-landing .callout p:first-child{color:var(--ink);font-weight:600}
.wp-landing .apply{background:var(--ink);color:var(--paper);border-bottom:none}
.wp-landing .apply .shead{color:#8fb6cc;border-bottom-color:rgba(255,255,255,.18)}
.wp-landing .apply h2{color:var(--paper)}
.wp-landing .apply p{color:#c3ccd4}
.wp-landing .apply ol.steps li::before{background:var(--ink);border-color:rgba(255,255,255,.28);color:#8fb6cc}
.wp-landing .apply ol.steps h3{color:var(--paper)}
.wp-landing .apply ol.steps p{color:#c3ccd4}
.wp-landing .apply .wbtn{background:var(--paper);color:var(--ink);border-color:var(--paper)}
.wp-landing .apply .wbtn:hover{background:#8fb6cc;border-color:#8fb6cc;color:var(--ink)}
.wp-landing .apply a{color:#9cc4da;border-bottom-color:rgba(156,196,218,.4)}
.wp-landing .apply-cta{margin-top:2.2rem;display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap}
.wp-landing .apply-cta .aside{font-family:var(--sans);font-size:.88rem;color:#8b98a4}
.wp-landing footer{padding:2.6rem 0;font-family:var(--sans);font-size:.87rem;color:var(--ink-faint)}
.wp-landing footer .wrap{display:flex;justify-content:space-between;gap:1.2rem;flex-wrap:wrap}
.wp-landing footer a{color:var(--ink-soft);border-bottom-color:var(--rule)}
@media (max-width:860px){
  .wp-landing .hero-grid{grid-template-columns:1fr;gap:2.6rem}
  .wp-landing .hero{padding:3rem 0 2.8rem}
  .wp-landing .cols{grid-template-columns:1fr;gap:2rem}
  .wp-landing section{padding:2.8rem 0}
  .wp-landing .terms th{width:8.5rem;font-size:.8rem}
}
@media (max-width:540px){
  .wp-landing{font-size:1rem}
  .wp-landing .terms{display:block}
  .wp-landing .terms tbody,.wp-landing .terms tr,.wp-landing .terms th,.wp-landing .terms td{display:block;width:auto}
  .wp-landing .terms th{border-bottom:none;padding-bottom:.1rem}
  .wp-landing .terms td{padding-top:0;padding-bottom:.85rem}
  .wp-landing .wrow{font-size:.83rem}
  .wp-landing .wrow .src em{display:none}
}
@media (prefers-reduced-motion:reduce){
  .wp-landing .anim .wrow,.wp-landing .anim .wtotal{opacity:1;transform:none;transition:none}
}
`;

export function Welcome() {
  const ledgerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,600;1,8..60,400&display=swap";
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  useEffect(() => {
    const el = ledgerRef.current;
    if (!el) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.remove("anim");
      return;
    }
    const items = el.querySelectorAll(".wrow, .wtotal");
    items.forEach((item, i) => { (item as HTMLElement).style.transitionDelay = `${0.1 + i * 0.085}s`; });
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("go")));
  }, []);

  return (
    <div className="wp-landing">
      <style>{CSS}</style>

      <header className="masthead">
        <div className="wrap">
          <div className="mark">Wealth<span>Prism</span></div>
          <div className="masthead-right">
            <span className="meta">Coimbatore · hiring our first domain hire</span>
            <Link className="login-link" to="/login">Client login →</Link>
          </div>
        </div>
      </header>

      <div className="hero">
        <div className="wrap hero-grid">
          <div>
            <h1>A family should know what it owns by Tuesday, not by July.</h1>
            <p className="lede">WealthPrism is a micro family office operating platform for Indian families holding <strong>₹25–250 crore</strong> — too small for an institutional multi-family office, too complex for a spreadsheet. We consolidate what they own, reconcile it, and produce the monthly pack a real family office provides.</p>
            <p className="lede" style={{ marginTop: "1.05em" }}>The prototype works. The engineering team is in place. We are hiring the person who knows what a CAS statement and a trust deed actually contain — and can tell the team what to build.</p>
            <div className="hero-cta">
              <a className="wbtn" href="#role">Read the role</a>
              <span className="aside">Full-time · Coimbatore · ₹6 LPA plus ESOP</span>
            </div>
          </div>

          <div className="ledger anim" id="ledger" ref={ledgerRef}>
            <div className="ledger-head">
              <span className="t">Consolidated position</span>
              <span className="d">31 Aug 2026</span>
            </div>
            <div className="wrow"><span className="src">Listed equity <em>2 demat</em></span><span className="amt">₹12.40 Cr</span></div>
            <div className="wrow"><span className="src">Mutual funds <em>CAMS, KFintech</em></span><span className="amt">₹9.85 Cr</span></div>
            <div className="wrow"><span className="src">PMS &amp; AIF <em>2 managers</em></span><span className="amt">₹6.20 Cr</span></div>
            <div className="wrow"><span className="src">Fixed income &amp; bank</span><span className="amt">₹4.15 Cr</span></div>
            <div className="wrow"><span className="src">Real estate <em>3 properties</em></span><span className="amt">₹14.60 Cr</span></div>
            <div className="wrow flagged"><span className="src">Unlisted holdings <em>valuation stale</em></span><span className="amt">₹4.30 Cr</span></div>
            <div className="wtotal"><span>Total</span><span>₹51.50 Cr</span></div>
            <p className="ledger-note">Nine sources, four entities, one statement. The red line is the point of the job: someone has to decide what a stale valuation means and how the platform should say so.</p>
          </div>
        </div>
      </div>

      <section>
        <div className="wrap">
          <p className="shead">What we are building</p>
          <h2>The work you have done by hand, done by software</h2>
          <div className="body wide">
            <p>Statements arriving from CAMS, KFintech, three brokers, two PMS managers and a bank. A property in an HUF, another in a spouse's name, a stake in the family business that nobody has valued since 2023. Capital gains reconstructed from scratch every year because nobody kept the ledger running.</p>
            <p>WealthPrism holds all of it in one place — instruments, entities, holders, transactions, valuations, corporate actions — and produces the pack the family actually reads: holdings, cash flow and liquidity, allocation, entity-wise tax position, a live capital-gains ledger, and the obligations coming up next quarter.</p>
            <p>We are bootstrapped and founder-led. There is a working prototype, two engineers and a project coordinator. There is no marketing department and no runway pressure from investors — which means we can build the thing properly, and it also means the salary is what it is. More on that below.</p>
          </div>
        </div>
      </section>

      <section id="role">
        <div className="wrap">
          <p className="shead">The role</p>
          <h2>Founding Domain Associate</h2>
          <div className="body wide">
            <p>You are the domain authority. The engineering team builds what you specify; the founder handles capital and brings the first families. You own four things.</p>
          </div>
          <ol className="steps" style={{ marginTop: "2rem" }}>
            <li>
              <h3>Specify the product from the numbers up</h3>
              <p>Define the data model and every core report to field level — consolidated statement, cash flow and liquidity, allocation drift, entity-wise tax position, capital-gains ledger, upcoming obligations.</p>
            </li>
            <li>
              <h3>Write the reconciliation rules</h3>
              <p>What comes from CAMS, KFintech, brokers, banks and registrars; how often; who reconciles it; and what the platform does when two sources disagree.</p>
            </li>
            <li>
              <h3>Turn domain knowledge into build-ready documents</h3>
              <p>Weekly written specifications the engineers can build from without a meeting: templates with field definitions, sample data, worked examples, edge cases, acceptance criteria. This is most of the job.</p>
            </li>
            <li>
              <h3>Run it for the first ten families</h3>
              <p>Onboard each family end to end — collect statements, structure entities, load and reconcile, produce the first monthly pack — then turn what they ask for into prioritised product changes.</p>
            </li>
          </ol>
        </div>
      </section>

      <section>
        <div className="wrap">
          <p className="shead">Who we are looking for</p>
          <h2>Two routes in. Same title, same terms.</h2>
          <div className="cols" style={{ marginTop: "2rem" }}>
            <div>
              <h3>If you are a Chartered Accountant</h3>
              <p>Qualified CA, or CA Final with articleship completed, around two years in. You have served promoter or HNI clients and have personally prepared capital-gains computations from CAS and broker statements, handled HUF or trust returns, and reconciled portfolio data that refused to agree with itself.</p>
              <p>You would lead on tax, entities and reconciliation first.</p>
            </div>
            <div>
              <h3>If you are a CFA candidate</h3>
              <p>Level 1 cleared and preparing for Level 2, around two years in wealth management, portfolio operations, fund administration, research or a PMS/RIA back office. You have worked with real portfolio data — NAVs, corporate actions, performance calculation, allocation.</p>
              <p>You would lead on portfolio analytics and reporting first, with a CA available to review the tax side while you build that knowledge.</p>
            </div>
          </div>
          <div className="body wide" style={{ marginTop: "2.4rem" }}>
            <p>Either way, three things are not negotiable:</p>
            <ul className="plain">
              <li>You have worked with real client or portfolio data, not only exam material.</li>
              <li>You can write. This role produces specifications and worked examples every week, and nobody will do that part for you.</li>
              <li>You can set your own agenda. The founder is time-constrained; you will be given outcomes, not instructions.</li>
            </ul>
            <p style={{ marginTop: "1.2rem" }}>This is not the right role if you want to stay in practice, or if you are looking for a research or fund-management seat and this is the gap between exams. We would rather you told us that now.</p>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <p className="shead">Terms</p>
          <h2>What we can and cannot offer</h2>
          <table className="terms">
            <tbody>
              <tr><th>Salary</th><td>₹6,00,000 per annum. Bootstrapped, so this is below what a large firm would pay. We would rather you knew in the first minute than the third conversation — the equity below is where the upside sits.</td></tr>
              <tr><th>Equity</th><td>An ESOP grant on completing twelve months against written outcomes, vesting over three further years with a one-year cliff. The size of the grant and the criteria are agreed and documented the day you join.</td></tr>
              <tr><th>Location</th><td>Full-time, in office, R.S. Puram, Coimbatore. This is not a remote role — the first year involves sitting with the engineers and with families.</td></tr>
              <tr><th>Exams</th><td>Study leave supported for your CA or CFA cycle, agreed in writing when you join.</td></tr>
              <tr><th>Reporting</th><td>Directly to the founder, with a fixed weekly review. No layers.</td></tr>
              <tr><th>Where it leads</th><td>Head of Family Office Operations as the client base grows. The first person you hire will be your own.</td></tr>
            </tbody>
          </table>
          <div className="callout">
            <p>If you are a CA in practice rather than looking for a job</p>
            <p>We would still like to hear from you. Practising CAs can use WealthPrism with their own HNI clients during the beta at no cost, in exchange for telling us honestly what is missing. Write to us with a line about your practice.</p>
          </div>
        </div>
      </section>

      <section className="apply" id="apply">
        <div className="wrap">
          <p className="shead">How to apply</p>
          <h2>We shortlist on a work sample, not a CV.</h2>
          <div className="body wide">
            <p>One page tells us more than an hour of interviewing. Send three things to <a href="mailto:careers@wealthprism.in">careers@wealthprism.in</a>.</p>
          </div>
          <ol className="steps" style={{ marginTop: "2rem" }}>
            <li>
              <h3>The work sample</h3>
              <p>Using your own sample data, build the monthly consolidated statement you would give a ₹50-crore family holding equities, mutual funds, one PMS, one property and an HUF. Show the sections, the fields in each, where every number comes from, and how you would reconcile it. Excel or PDF. One page.</p>
            </li>
            <li>
              <h3>A short note</h3>
              <p>What you have personally prepared for real clients, for how many, and with what tools. Tell us which route you are applying under and your CA or CFA status.</p>
            </li>
            <li>
              <h3>The practical details</h3>
              <p>Current CTC, notice period, and your exam timetable for the next eighteen months if you are mid-qualification.</p>
            </li>
          </ol>
          <div className="apply-cta">
            <a className="wbtn" href="mailto:careers@wealthprism.in?subject=Founding%20Domain%20Associate%20application">Send your application</a>
            <span className="aside">Every application with a work sample gets a reply.</span>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>WealthPrism · R.S. Puram, Coimbatore, Tamil Nadu</span>
          <span><a href="mailto:careers@wealthprism.in">careers@wealthprism.in</a></span>
        </div>
      </footer>
    </div>
  );
}
