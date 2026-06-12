const fs = require('fs');
let c = fs.readFileSync('C:/Users/supra/Videos/mailmind/public/index.html', 'utf8');

// ── 1. Replace old chip CSS ───────────────────────────────────────────────────
const OLD_CHIP_CSS = `/* category chips */
.chip-imp{background:oklch(52% 0.20 280 / 0.12);color:oklch(65% 0.20 280);border:1px solid oklch(52% 0.20 280 / 0.35)}
.chip-promo{background:oklch(60% 0.18 60 / 0.10);color:oklch(60% 0.18 60);border:1px solid oklch(60% 0.18 60 / 0.35)}
.chip-social{background:oklch(55% 0.18 200 / 0.10);color:oklch(55% 0.18 200);border:1px solid oklch(55% 0.18 200 / 0.35)}
.chip-fin{background:oklch(58% 0.18 148 / 0.10);color:oklch(58% 0.18 148);border:1px solid oklch(58% 0.18 148 / 0.35)}
.chip-upd{background:oklch(55% 0.08 100 / 0.10);color:var(--t2);border:1px solid var(--bc)}
.chip-cc{background:oklch(68% 0.12 280 / 0.10);color:oklch(68% 0.12 280);border:1px solid oklch(68% 0.12 280 / 0.30)}`;

const NEW_CHIP_CSS = `/* category chips - India-aware 9-category system */
.chip-work{background:oklch(38% 0.16 240/0.13);color:oklch(68% 0.16 240);border:1px solid oklch(38% 0.16 240/0.36)}
.chip-fin{background:oklch(42% 0.18 148/0.12);color:oklch(62% 0.18 148);border:1px solid oklch(42% 0.18 148/0.36)}
.chip-shop{background:oklch(55% 0.18 55/0.12);color:oklch(70% 0.18 55);border:1px solid oklch(55% 0.18 55/0.36)}
.chip-news{background:oklch(42% 0.14 300/0.10);color:oklch(64% 0.14 300);border:1px solid oklch(42% 0.14 300/0.36)}
.chip-promo{background:oklch(58% 0.20 80/0.10);color:oklch(68% 0.20 80);border:1px solid oklch(58% 0.20 80/0.36)}
.chip-pers{background:oklch(55% 0.18 350/0.10);color:oklch(68% 0.18 350);border:1px solid oklch(55% 0.18 350/0.36)}
.chip-sec{background:oklch(50% 0.22 22/0.14);color:oklch(66% 0.22 22);border:1px solid oklch(50% 0.22 22/0.42)}
.chip-gov{background:oklch(38% 0.14 260/0.12);color:oklch(60% 0.14 260);border:1px solid oklch(38% 0.14 260/0.36)}
.chip-spam{background:oklch(45% 0.22 15/0.13);color:oklch(62% 0.22 15);border:1px solid oklch(45% 0.22 15/0.42)}
.chip-cc{background:oklch(68% 0.12 280/0.10);color:oklch(68% 0.12 280);border:1px solid oklch(68% 0.12 280/0.30)}`;

if (c.includes(OLD_CHIP_CSS)) {
  c = c.replace(OLD_CHIP_CSS, NEW_CHIP_CSS);
  console.log('✓ Chip CSS replaced');
} else {
  console.log('✗ Chip CSS not found, trying partial match');
  c = c.replace(/\/\* category chips \*\/[\s\S]*?\.chip-cc\{[^}]+\}/, NEW_CHIP_CSS);
  console.log('   Partial match applied');
}

// ── 2. Replace cat-tabs HTML ──────────────────────────────────────────────────
const OLD_TABS = `    <div class="cat-tabs" id="cat-tabs">
      <button class="cat-tab on" data-cat="all">All</button>
      <button class="cat-tab" data-cat="important">Important</button>
      <button class="cat-tab" data-cat="financial">Financial</button>
      <button class="cat-tab" data-cat="promotional">Promotions</button>
      <button class="cat-tab" data-cat="social">Social</button>
      <button class="cat-tab" data-cat="updates">Updates</button>
    </div>`;

const NEW_TABS = `    <div class="cat-tabs" id="cat-tabs">
      <button class="cat-tab on" data-cat="all">All</button>
      <button class="cat-tab" data-cat="work">&#x1F4BC; Work</button>
      <button class="cat-tab" data-cat="financial">&#x1F4B0; Finance</button>
      <button class="cat-tab" data-cat="shopping">&#x1F4E6; Orders</button>
      <button class="cat-tab" data-cat="newsletter">&#x1F4F0; Newsletter</button>
      <button class="cat-tab" data-cat="promotional">&#x1F3AF; Promos</button>
      <button class="cat-tab" data-cat="personal">&#x1F464; Personal</button>
      <button class="cat-tab" data-cat="security">&#x1F510; Security</button>
      <button class="cat-tab" data-cat="government">&#x1F3DB; Govt</button>
    </div>`;

if (c.includes(OLD_TABS)) {
  c = c.replace(OLD_TABS, NEW_TABS);
  console.log('✓ Category tabs HTML replaced');
} else {
  console.log('✗ Category tabs not found exactly');
  c = c.replace(/\s*<div class="cat-tabs" id="cat-tabs">[\s\S]*?<\/div>(?=\s*<div class="el-scroll")/, '\n' + NEW_TABS);
  console.log('   Regex replacement applied');
}

// ── 3. Replace the full categorize() function ─────────────────────────────────
const catStart = c.indexOf('// ── Client-side email categorisation');
const catEnd   = c.indexOf('\n// Refresh category tab counts');
if (catStart !== -1 && catEnd !== -1) {
  const NEW_CAT = `// ── Email categorisation — India-aware 9-category system ────────────────────
function categorize(email) {
  const subj   = (email.subject  || '').toLowerCase();
  const sender = (email.sender   || '').toLowerCase();
  const snip   = (email.snippet  || '').toLowerCase();
  const all    = subj + ' ' + sender + ' ' + snip;
  const dom    = sender.match(/@([a-z0-9.\\-]+)/)?.[1] || '';

  // Use Outlook categories if already tagged
  if ((email.categories||[]).some(function(x){return /financ|invoice|payment|bank|upi/i.test(x);})) return 'financial';
  if ((email.categories||[]).some(function(x){return /work|project|hr|jira/i.test(x);}))           return 'work';
  if ((email.categories||[]).some(function(x){return /promo|market|newsletter|offer/i.test(x);}))  return 'promotional';

  // 1. SECURITY - OTP, login alerts (highest priority)
  if (/otp|one.time.pass|two.factor|2fa|login.attempt|new.device.sign|account.locked|suspicious.activ|sign-?in.attempt|verify.your.email|password.reset|authentication.code|security.alert|unusual.activ|new.sign.?in/i.test(all)
    || /security@|alerts@/.test(sender) || /donotreply@.*bank|noreply@.*bank|noreply@.*pay/.test(sender))
    return 'security';

  // 2. GOVERNMENT - .gov.in, IRCTC, EPFO, UIDAI
  if (/\\.gov\\.in$|irctc\\.co\\.in$|epfindia\\.|uidai\\.|incometax\\.|cbdt\\.|digilocker\\./.test(dom)
    || /itr.filed|itr.refund|assessment.year|pnr.no|e-?ticket|irctc.booking|epf.withdrawal|uan.passbook|aadhaar.update|digilocker|jan.dhan|notice.under.section|form.26as|ais.statement|traces.refund/i.test(all))
    return 'government';

  // 3. FINANCIAL - banks, UPI, investments, invoices
  if (/sbi|hdfc|icici|axis.bank|kotak|phonepe|gpay|paytm|bhim|razorpay|stripe|paypal|zerodha|groww|upstox|angel.one|quickbooks|xero|zoho.books/.test(dom + ' ' + sender)
    || /upi |neft|rtgs|imps|nach|debited|credited|transaction.id|emi |loan.statement|interest.rate|outstanding.amount|form.16|tds.certif|gst.invoice|mutual.fund| sip |nav |folio.no|portfolio.value|invoice|payment.due|overdue|wire.transfer|salary.credit|payslip|ctc /i.test(all)
    || /[₹$]\s*\d|account.xxxx|card.ending|account.no.*\d{4}/i.test(all))
    return 'financial';

  // 4. WORK / PROFESSIONAL - tools, job portals, office keywords
  if (/workday|bamboohr|greenhouse|atlassian|jira|asana|notion|github|gitlab|bitbucket|slack|confluence|trello|monday|freshdesk|naukri|internshala|apna\.co|instahyre/i.test(sender)
    || /offer.letter|annual.ctc|appraisal|increment|payslip|pf.account|esic|joining.date|relieving.letter|meeting.agenda|action.item|deliverable|milestone|project.proposal|performance.review|kpi|okr|please.revert|do.the.needful|as.discussed|per.our.call|follow.up.*meeting|wfh|work.from.home|pull.request|code.review|sprint|standup|deployment/i.test(all))
    return 'work';

  // 5. SHOPPING / ORDERS - e-commerce, delivery
  if (/flipkart|amazon|meesho|myntra|nykaa|ajio|snapdeal|bigbasket|blinkit|zepto|jiomart|ebay|etsy|shopify/i.test(sender)
    || /order.confirm|order.placed|order.shipped|out.for.delivery|delivered.success|your.package|tracking.number|estimated.delivery|delhivery|bluedart|ekart|dtdc|cash.on.delivery|cod |return.request|replacement.init|refund.initiat|dispatched|shipment.detail/i.test(all))
    return 'shopping';

  // 6. SPAM - fraud, fake KYC, prize scams
  if (/you.?ve.been.selected|you.have.won|claim.your.prize|free.gift.*click|winner.*selected|lottery.*won|crore.*won|lakh.*prize|account.*blocked.*kyc|update.*kyc.*immediately|aadhaar.*suspend|rbi.*freeze/i.test(all)
    || /!!!/.test(subj) && /free|win|prize|lottery|selected|congratul/i.test(subj))
    return 'spam';

  // 7. NEWSLETTER / SUBSCRIPTIONS
  if (/substack|mailchimp|convertkit|beehiiv|constantcontact|sendgrid|theken\.co|finshots|morningcontext|moneycontrol|economictimes|livemint|theprint|thewire|scroll\.in/i.test(sender)
    || /morning.digest|weekly.wrap|today.s.briefing|newsletter|bulletin|roundup|view.in.browser|you.?re.receiving.this|manage.your.subscri|unsubscribe.here/i.test(all))
    return 'newsletter';

  // 8. PROMOTIONS / MARKETING - offers, discounts, festive sales
  if (/zomato|swiggy|ola |uber |makemytrip|yatra\.com|goibibo|cleartrip|jio |airtel|bsnl|offers@|deals@|marketing@|promo@|promotions@/i.test(sender)
    || /\\d+\\s*%.?off|cashback|coupon.code|use.code|flat.\\u20B9|upto.\\u20B9|limited.offer|today.only|don.?t.miss|festive.sale|big.billion|great.indian.sale|end.of.reason|flash.sale|shop.now|claim.your.offer|expires.soon|black.friday|recharge.offer/i.test(all)
    || /no-?reply@|noreply@/.test(sender) && /offer|deal|sale|discount|promo/i.test(subj))
    return 'promotional';

  // 9. PERSONAL - personal email addresses with no corporate signals
  if (/@gmail\\.com$|@yahoo\\.co\\.in$|@yahoo\\.com$|@hotmail\\.com$|@outlook\\.com$|@rediffmail\\.com$|@icloud\\.com$/i.test(dom)
    && !/noreply|no-reply|donotreply|newsletter|alert|notification|support|help@|info@|admin@|team@/i.test(sender)
    && !all.includes('unsubscribe'))
    return 'personal';

  // Default
  return 'work';
}
`;
  c = c.slice(0, catStart) + NEW_CAT + c.slice(catEnd);
  console.log('✓ categorize() replaced');
} else {
  console.log('✗ categorize() bounds not found:', catStart, catEnd);
}

// ── 4. Update updateCatCounts ─────────────────────────────────────────────────
c = c.replace(
  'const counts = {important:0, financial:0, promotional:0, social:0, updates:0};',
  'const counts = {work:0, financial:0, shopping:0, newsletter:0, promotional:0, personal:0, security:0, government:0, spam:0};'
);
console.log('✓ updateCatCounts updated:', c.includes('work:0, financial:0, shopping:0'));

// ── 5. Replace getCatChip ─────────────────────────────────────────────────────
const gStart = c.indexOf('// ── Category chip helper');
const gEnd   = c.indexOf('\n\n// ── Render list');
if (gStart !== -1 && gEnd !== -1) {
  const NEW_CHIP_FN = `// ── Category chip helper ──────────────────────────────────────────────────────
function getCatChip(email) {
  try {
    var cat = categorize(email);
    var map = {
      work:        ['chip-work',  '&#x1F4BC;'],
      financial:   ['chip-fin',   '&#x1F4B0;'],
      shopping:    ['chip-shop',  '&#x1F4E6;'],
      newsletter:  ['chip-news',  '&#x1F4F0;'],
      promotional: ['chip-promo', '&#x1F3AF;'],
      personal:    ['chip-pers',  '&#x1F464;'],
      security:    ['chip-sec',   '&#x1F510;'],
      government:  ['chip-gov',   '&#x1F3DB;&#xFE0F;'],
      spam:        ['chip-spam',  '&#x1F5D1;&#xFE0F;'],
    };
    var pair = map[cat];
    return pair ? '<span class="chip ' + pair[0] + '" title="' + cat + '">' + pair[1] + '</span>' : '';
  } catch(e) { return ''; }
}`;
  c = c.slice(0, gStart) + NEW_CHIP_FN + c.slice(gEnd);
  console.log('✓ getCatChip() replaced');
} else {
  console.log('✗ getCatChip bounds not found:', gStart, gEnd);
}

// ── 6. Syntax check ───────────────────────────────────────────────────────────
try {
  var js = c.slice(c.indexOf('<script>') + 8, c.lastIndexOf('</script>'));
  new Function(js);
  console.log('✓ JS syntax OK');
} catch(e) { console.log('✗ JS syntax:', e.message); }

// Final checks
[
  ['work tab',           c.includes('data-cat="work"')],
  ['security return',    c.includes("return 'security'")],
  ['government return',  c.includes("return 'government'")],
  ['shopping return',    c.includes("return 'shopping'")],
  ['personal return',    c.includes("return 'personal'")],
  ['spam return',        c.includes("return 'spam'")],
  ['chip-sec CSS',       c.includes('.chip-sec{')],
  ['chip-shop CSS',      c.includes('.chip-shop{')],
  ['chip-gov CSS',       c.includes('.chip-gov{')],
  ['chip-work CSS',      c.includes('.chip-work{')],
].forEach(function(p){ console.log(p[1] ? '✓' : '✗', p[0]); });

fs.writeFileSync('C:/Users/supra/Videos/mailmind/public/index.html', c, 'utf8');
console.log('Done');
