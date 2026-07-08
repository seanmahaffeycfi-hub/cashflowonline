/* app.js - full file (copy-paste)
   - Unified modal dialog for edits
   - Cash flow month/year selectors; paydates computed from income.nextpay anchor
   - Biweekly = anchor + n * 14 days
   - Bills tab columns: Item | Amount | Day | Account | Owner | Actions
   - Result tab: assigned bills sum by owner (regardless of account) and ignore Paid checkbox
   - Export filename now uses machine local time in MMMDDYYYYHHMM (24-hour) format
   - Robust import/export (BOM stripping, legacy p1/p2 migration, normalization)
   - Safe startup (DOMContentLoaded) and localStorage persistence
*/

/* ---------------------------
   Runtime state and constants
   --------------------------- */
let state = {
  incomes: [],
  bills: [] // { id, name, amt, due, account, owner, paid }
};

const ACCOUNTS = ["USAA", "USAA Saving", "Chase", "CapOne"];
const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly"];
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/* ---------------------------
   Supabase cloud sync
   - Fill in SUPABASE_URL and SUPABASE_ANON_KEY from your project's
     Settings -> API page.
   - HOUSEHOLD_ID is just the row key in the budget_state table; leave
     it as "household" unless you want a private/harder-to-guess id.
   --------------------------- */
const SUPABASE_URL = "https://vfbblmazuakngnisdnab.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmYmJsbWF6dWFrbmduaXNkbmFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMjAxNzUsImV4cCI6MjA5ODY5NjE3NX0.jTokAfeVH-2SFj5vkWNMPGEafoUqqQZqYOaCmknjzho";

let supabaseClient = null;
if (window.supabase && SUPABASE_URL.indexOf("YOUR-PROJECT") === -1) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

let currentUser = null;
let currentHouseholdId = null; // resolved after sign-in, from household_members
let realtimeChannel = null; // guards against subscribing more than once
let cloudSaveTimer = null;
let applyingRemoteUpdate = false; // guard so remote updates don't immediately re-save
let lastPushedAt = 0; // used to ignore our own realtime echo

/* ---------------------------
   Auth
   --------------------------- */
let authMode = "signin"; // "signin" or "signup"

function toggleAuthMode() {
  authMode = authMode === "signin" ? "signup" : "signin";
  const title = document.getElementById("auth-title");
  const submitBtn = document.getElementById("auth-submit-btn");
  const toggleText = document.getElementById("auth-toggle-text");
  const toggleLink = document.getElementById("auth-toggle-link");
  const statusEl = document.getElementById("auth-status");

  if (authMode === "signup") {
    title.textContent = "Create account";
    submitBtn.textContent = "Create account";
    toggleText.textContent = "Already have an account?";
    toggleLink.textContent = "Sign in";
  } else {
    title.textContent = "Sign in";
    submitBtn.textContent = "Sign in";
    toggleText.textContent = "Don't have an account?";
    toggleLink.textContent = "Create one";
  }
  statusEl.textContent = "";
}

async function submitAuth() {
  const statusEl = document.getElementById("auth-status");
  const email = (document.getElementById("auth-email").value || "").trim();
  const password = document.getElementById("auth-password").value || "";

  if (!supabaseClient) {
    statusEl.textContent = "Supabase isn't configured yet (check SUPABASE_URL/KEY in app.js).";
    return;
  }
  if (!email || !password) {
    statusEl.textContent = "Enter both email and password.";
    return;
  }
  if (password.length < 6) {
    statusEl.textContent = "Password must be at least 6 characters.";
    return;
  }

  statusEl.textContent = authMode === "signup" ? "Creating account..." : "Signing in...";

  if (authMode === "signup") {
    const { error } = await supabaseClient.auth.signUp({ email, password });
    statusEl.textContent = error ? ("Error: " + error.message) : "Account created! Check your email to confirm, then sign in.";
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    statusEl.textContent = error ? ("Error: " + error.message) : "";
  }
}

async function sendPasswordReset() {
  const statusEl = document.getElementById("auth-status");
  const email = (document.getElementById("auth-email").value || "").trim();
  if (!supabaseClient) {
    statusEl.textContent = "Supabase isn't configured yet.";
    return;
  }
  if (!email) {
    statusEl.textContent = "Enter your email above first, then click Forgot password.";
    return;
  }
  statusEl.textContent = "Sending reset link...";
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
  statusEl.textContent = error ? ("Error: " + error.message) : "Check your email for a reset link.";
}

async function submitNewPassword() {
  const statusEl = document.getElementById("reset-status");
  const newPassword = document.getElementById("reset-password").value || "";
  if (newPassword.length < 6) {
    statusEl.textContent = "Password must be at least 6 characters.";
    return;
  }
  statusEl.textContent = "Saving...";
  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
  if (error) {
    statusEl.textContent = "Error: " + error.message;
    return;
  }
  statusEl.textContent = "Password updated! Reloading...";
  setTimeout(() => window.location.href = window.location.origin + window.location.pathname, 1000);
}

function signOut() {
  if (realtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(realtimeChannel);
  }
  realtimeChannel = null;
  currentHouseholdId = null;
  if (supabaseClient) supabaseClient.auth.signOut();
}

function showAuthGate() {
  const gate = document.getElementById("auth-gate");
  const app = document.querySelector(".app");
  if (gate) gate.style.display = "flex";
  if (app) app.style.display = "none";
}

async function handleSignedIn(user) {
  currentUser = user;
  const { data, error } = await supabaseClient
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  const statusEl = document.getElementById("auth-status");
  if (error || !data) {
    if (statusEl) statusEl.textContent = "Signed in, but your account isn't linked to a household yet. Add your user ID to household_members in Supabase.";
    return;
  }

  currentHouseholdId = data.household_id;
  const gate = document.getElementById("auth-gate");
  const app = document.querySelector(".app");
  if (gate) gate.style.display = "none";
  if (app) app.style.display = "block";

  load();
  subscribeToCloudUpdates();
}

async function initAuth() {
  if (!supabaseClient) {
    // No Supabase configured: fall back to local-only mode, skip the gate.
    const gate = document.getElementById("auth-gate");
    const app = document.querySelector(".app");
    if (gate) gate.style.display = "none";
    if (app) app.style.display = "block";
    load();
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await handleSignedIn(session.user);
  } else {
    showAuthGate();
  }

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      const authGate = document.getElementById("auth-gate");
      const resetGate = document.getElementById("reset-gate");
      const app = document.querySelector(".app");
      if (authGate) authGate.style.display = "none";
      if (app) app.style.display = "none";
      if (resetGate) resetGate.style.display = "flex";
      return;
    }
    if (session) handleSignedIn(session.user);
    else showAuthGate();
  });
}

async function pushStateToCloud() {
  if (!supabaseClient || !currentHouseholdId || applyingRemoteUpdate) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(async () => {
    try {
      const now = new Date().toISOString();
      lastPushedAt = Date.now();
      const { error } = await supabaseClient
        .from("budget_state")
        .upsert({ household_id: currentHouseholdId, data: state, updated_at: now });
      if (error) {
        console.warn("Cloud save failed:", error.message);
        showToast("Cloud sync failed (saved locally only)", true);
      }
    } catch (e) {
      console.warn("Cloud save error:", e);
    }
  }, 600); // debounce rapid edits into one write
}

async function pullStateFromCloud() {
  if (!supabaseClient || !currentHouseholdId) return false;
  try {
    const { data, error } = await supabaseClient
      .from("budget_state")
      .select("data, updated_at")
      .eq("household_id", currentHouseholdId)
      .single();
    if (error) {
      console.warn("Cloud load failed:", error.message);
      return false;
    }
    if (data && data.data && Object.keys(data.data).length > 0) {
      applyingRemoteUpdate = true;
      state = Object.assign({}, state, data.data);
      if (!Array.isArray(state.incomes)) state.incomes = [];
      if (!Array.isArray(state.bills)) state.bills = [];
      try { localStorage.setItem("hb-state5", JSON.stringify(state)); } catch (e) {}
      applyState();
      renderIncomes();
      renderBillAccountOptions();
      renderBillOwnerOptions();
      renderBills();
      renderFlow();
      renderResult();
      applyingRemoteUpdate = false;
      return true;
    }
    return false;
  } catch (e) {
    console.warn("Cloud load error:", e);
    return false;
  }
}

function subscribeToCloudUpdates() {
  if (!supabaseClient || !currentHouseholdId) return;
  if (realtimeChannel) return; // already subscribed; avoid re-adding listeners to the same channel
  realtimeChannel = supabaseClient
    .channel("budget_state_changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "budget_state", filter: `household_id=eq.${currentHouseholdId}` },
      (payload) => {
        // Ignore the echo of our own recent write
        if (Date.now() - lastPushedAt < 1500) return;
        const incoming = payload.new && payload.new.data;
        if (!incoming) return;
        applyingRemoteUpdate = true;
        state = Object.assign({}, state, incoming);
        if (!Array.isArray(state.incomes)) state.incomes = [];
        if (!Array.isArray(state.bills)) state.bills = [];
        try { localStorage.setItem("hb-state5", JSON.stringify(state)); } catch (e) {}
        applyState();
        renderIncomes();
        renderBillAccountOptions();
        renderBillOwnerOptions();
        renderBills();
        renderFlow();
        renderResult();
        applyingRemoteUpdate = false;
        showToast("Updated from other device");
      }
    )
    .subscribe();
}

/* Flow month/year selection (0-based month) */
let flowSelectedYear = (new Date()).getFullYear();
let flowSelectedMonth = (new Date()).getMonth();

/* ---------------------------
   Helpers
   --------------------------- */
function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function showToast(msg, isError = false) {
  let t = document.getElementById("app-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "app-toast";
    t.style.position = "fixed";
    t.style.right = "16px";
    t.style.bottom = "16px";
    t.style.padding = "10px 14px";
    t.style.borderRadius = "8px";
    t.style.zIndex = 9999;
    t.style.boxShadow = "0 6px 18px rgba(0,0,0,0.12)";
    t.style.fontFamily = "system-ui, sans-serif";
    t.style.fontSize = "14px";
    t.style.transition = "opacity 240ms ease";
    t.style.opacity = "0";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isError ? "#c33" : "#0a5";
  t.style.color = "#fff";
  t.style.opacity = "1";
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => { t.textContent = ""; }, 260);
  }, 3500);
}

/* ---------------------------
   Frequency & net calculations
   --------------------------- */
function checksPerMonth(freq) {
  return {
    biweekly: 2.167,
    weekly: 4.333,
    semimonthly: 2,
    monthly: 1
  }[freq] || 2;
}

function monthlyNetForIncome(inc) {
  const gross = (inc.income || 0) * checksPerMonth(inc.freq);
  return gross * (1 - ((inc.tax || 0) / 100));
}

/* ---------------------------
   Persistence: save / load / apply
   --------------------------- */
function save() {
  try {
    localStorage.setItem("hb-state5", JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save to localStorage", e);
  }
  // re-render everything that depends on state
  renderIncomes();
  renderBillAccountOptions();
  renderBillOwnerOptions();
  renderBills();
  renderFlow();
  renderResult();
  pushStateToCloud();
}

function load() {
  const saved = localStorage.getItem("hb-state5");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      state = Object.assign({}, state, parsed);
      if (!Array.isArray(state.incomes)) state.incomes = [];
      if (!Array.isArray(state.bills)) state.bills = [];
      // normalize bills
      state.bills = state.bills.map(b => Object.assign({ paid: false, account: ACCOUNTS[0], owner: "Shared" }, b));
    } catch (e) {
      console.warn("Failed to parse saved state:", e);
    }
  }
  applyState();
  renderIncomes();
  renderBillAccountOptions();
  renderBillOwnerOptions();
  renderBills();
  renderFlow();
  renderResult();
  ensureResetPaidButton();

  // After showing whatever we have locally, check the cloud for anything
  // newer (e.g. changes made from the other person's phone). The realtime
  // subscription for ongoing updates is set up separately in handleSignedIn().
  pullStateFromCloud();
}

/* ---------------------------
   Apply state to simple inputs
   --------------------------- */
function applyState() {
  // no simple top-level inputs left to sync
}

/* ---------------------------
   UI: Tab switching
   --------------------------- */
function showTab(id) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll("[id^='tab-']").forEach(div => div.style.display = "none");
  const btn = document.querySelector(`.tabs button[data-tab="${id}"]`);
  if (btn) btn.classList.add("active");
  const tab = document.getElementById(`tab-${id}`);
  if (tab) tab.style.display = "block";
  if (id === "result") renderResult();
}

/* ---------------------------
   Incomes: add / delete / edit / render
   --------------------------- */
function addIncome() {
  const name = (document.getElementById("income-name").value || "").trim();
  const income = parseFloat(document.getElementById("income-amt").value) || 0;
  const freq = document.getElementById("income-freq").value || "biweekly";
  const nextpay = document.getElementById("income-nextpay").value || "";
  const tax = parseFloat(document.getElementById("income-tax").value) || 0;

  if (!name || income === 0) {
    showToast("Please provide a name and non-zero amount", true);
    return;
  }

  const id = Date.now() + Math.floor(Math.random() * 1000);
  state.incomes.push({ id, name, income, freq, nextpay, tax });
  document.getElementById("income-name").value = "";
  document.getElementById("income-amt").value = "";
  document.getElementById("income-nextpay").value = "";
  document.getElementById("income-tax").value = "";
  save();
  showToast("Income added");
}

function deleteIncome(id) {
  state.incomes = state.incomes.filter(i => i.id !== id);
  save();
  showToast("Income removed");
}

/* New: unified modal dialog creation and helpers */
function ensureModalExists() {
  if (document.getElementById("edit-modal")) return;

  const overlay = document.createElement("div");
  overlay.id = "edit-modal";
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.background = "rgba(0,0,0,0.4)";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = 10000;

  const dialog = document.createElement("div");
  dialog.id = "edit-modal-dialog";
  dialog.style.background = "#fff";
  dialog.style.borderRadius = "8px";
  dialog.style.padding = "18px";
  dialog.style.width = "420px";
  dialog.style.maxWidth = "95%";
  dialog.style.boxShadow = "0 8px 30px rgba(0,0,0,0.2)";
  dialog.style.fontFamily = "system-ui, sans-serif";

  const title = document.createElement("div");
  title.id = "edit-modal-title";
  title.style.fontSize = "16px";
  title.style.fontWeight = "600";
  title.style.marginBottom = "12px";
  dialog.appendChild(title);

  const form = document.createElement("form");
  form.id = "edit-modal-form";
  form.onsubmit = (e) => { e.preventDefault(); modalSave(); };

  // We'll dynamically populate fields depending on type
  const fieldsContainer = document.createElement("div");
  fieldsContainer.id = "edit-modal-fields";
  fieldsContainer.style.display = "grid";
  fieldsContainer.style.gridTemplateColumns = "1fr";
  fieldsContainer.style.gap = "8px";
  form.appendChild(fieldsContainer);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.marginTop = "12px";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.marginRight = "8px";
  cancelBtn.onclick = () => closeModal();

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Save";

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  form.appendChild(actions);
  dialog.appendChild(form);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // store current editing context
  overlay._context = null;
}

function openModal(context) {
  // context: { type: 'income'|'bill', id: number|null, data: {...} }
  ensureModalExists();
  const overlay = document.getElementById("edit-modal");
  const title = document.getElementById("edit-modal-title");
  const fields = document.getElementById("edit-modal-fields");
  overlay._context = context;

  // clear fields
  fields.innerHTML = "";

  if (context.type === "income") {
    title.textContent = context.id ? "Edit Income" : "Add Income";

    // name
    fields.appendChild(labeledInput("Name", "modal-name", context.data.name || "", "text"));

    // amount
    fields.appendChild(labeledInput("Gross per pay", "modal-income", context.data.income != null ? String(context.data.income) : "", "number", { step: "0.01", min: "0" }));

    // frequency
    fields.appendChild(labeledSelect("Frequency", "modal-freq", FREQUENCIES, context.data.freq || "biweekly"));

    // nextpay
    fields.appendChild(labeledInput("Next pay (YYYY-MM-DD)", "modal-nextpay", context.data.nextpay || "", "text", { placeholder: "YYYY-MM-DD" }));

    // tax
    fields.appendChild(labeledInput("Tax %", "modal-tax", context.data.tax != null ? String(context.data.tax) : "0", "number", { step: "0.1", min: "0", max: "100" }));

  } else if (context.type === "bill") {
    title.textContent = context.id ? "Edit Bill" : "Add Bill";

    // name
    fields.appendChild(labeledInput("Name", "modal-name", context.data.name || "", "text"));

    // amount
    fields.appendChild(labeledInput("Amount", "modal-amt", context.data.amt != null ? String(context.data.amt) : "", "number", { step: "0.01", min: "0" }));

    // due day
    fields.appendChild(labeledInput("Due day (1-31)", "modal-due", context.data.due != null ? String(context.data.due) : "1", "number", { min: "1", max: "31" }));

    // account
    fields.appendChild(labeledSelect("Account", "modal-account", ACCOUNTS, context.data.account || ACCOUNTS[0]));

    // owner
    const ownerOptions = ["Shared"].concat(state.incomes.map(i => i.name));
    fields.appendChild(labeledSelect("Owner", "modal-owner", ownerOptions, context.data.owner || "Shared"));
  }

  overlay.style.display = "flex";
  // focus first input
  const first = fields.querySelector("input, select, textarea");
  if (first) first.focus();
}

function closeModal() {
  const overlay = document.getElementById("edit-modal");
  if (!overlay) return;
  overlay.style.display = "none";
  overlay._context = null;
}

function labeledInput(labelText, id, value, type = "text", attrs = {}) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  label.style.fontSize = "13px";
  label.style.marginBottom = "4px";

  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value != null ? value : "";
  input.style.padding = "8px";
  input.style.border = "1px solid #ccc";
  input.style.borderRadius = "6px";
  input.style.fontSize = "14px";

  Object.keys(attrs || {}).forEach(k => input.setAttribute(k, attrs[k]));

  wrapper.appendChild(label);
  wrapper.appendChild(input);
  return wrapper;
}

function labeledSelect(labelText, id, options, selected) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  label.style.fontSize = "13px";
  label.style.marginBottom = "4px";

  const sel = document.createElement("select");
  sel.id = id;
  sel.style.padding = "8px";
  sel.style.border = "1px solid #ccc";
  sel.style.borderRadius = "6px";
  sel.style.fontSize = "14px";

  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (String(opt) === String(selected)) o.selected = true;
    sel.appendChild(o);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(sel);
  return wrapper;
}

function modalSave() {
  const overlay = document.getElementById("edit-modal");
  if (!overlay || !overlay._context) return;
  const ctx = overlay._context;

  if (ctx.type === "income") {
    const name = (document.getElementById("modal-name").value || "").trim();
    const income = parseFloat(document.getElementById("modal-income").value) || 0;
    const freq = document.getElementById("modal-freq").value || "biweekly";
    const nextpay = (document.getElementById("modal-nextpay").value || "").trim();
    const tax = parseFloat(document.getElementById("modal-tax").value) || 0;

    if (!name || income <= 0) {
      showToast("Please provide a name and a positive income amount", true);
      return;
    }
    if (nextpay && !/^\d{4}-\d{2}-\d{2}$/.test(nextpay)) {
      showToast("Next pay must be YYYY-MM-DD or blank", true);
      return;
    }

    if (ctx.id) {
      // update existing
      const inc = state.incomes.find(i => i.id === ctx.id);
      if (!inc) { showToast("Income not found", true); closeModal(); return; }
      inc.name = name;
      inc.income = income;
      inc.freq = freq;
      inc.nextpay = nextpay;
      inc.tax = tax;
      // update any owner selects in bills if name changed
    } else {
      // create new
      const id = Date.now() + Math.floor(Math.random() * 1000);
      state.incomes.push({ id, name, income, freq, nextpay, tax });
    }

    save();
    closeModal();
    showToast("Income saved");
  } else if (ctx.type === "bill") {
    const name = (document.getElementById("modal-name").value || "").trim();
    const amt = parseFloat(document.getElementById("modal-amt").value) || 0;
    const due = parseInt(document.getElementById("modal-due").value) || 1;
    const account = document.getElementById("modal-account").value || ACCOUNTS[0];
    const owner = document.getElementById("modal-owner").value || "Shared";

    if (!name || amt <= 0) {
      showToast("Please provide a name and a positive amount", true);
      return;
    }
    if (isNaN(due) || due < 1 || due > 31) {
      showToast("Due day must be between 1 and 31", true);
      return;
    }

    if (ctx.id) {
      const bill = state.bills.find(b => b.id === ctx.id);
      if (!bill) { showToast("Bill not found", true); closeModal(); return; }
      bill.name = name;
      bill.amt = amt;
      bill.due = due;
      bill.account = account;
      bill.owner = owner;
    } else {
      state.bills.push({ id: Date.now(), name, amt, due, account, owner, paid: false });
    }

    save();
    closeModal();
    showToast("Bill saved");
  }
}

/* ---------------------------
   Edit functions now open modal
   --------------------------- */
function editIncome(id) {
  const inc = state.incomes.find(i => i.id === id);
  if (!inc) { showToast("Income not found", true); return; }
  openModal({ type: "income", id: id, data: Object.assign({}, inc) });
}

function editBill(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) { showToast("Bill not found", true); return; }
  openModal({ type: "bill", id: id, data: Object.assign({}, bill) });
}

/* ---------------------------
   Render incomes table (Edit button uses modal)
   --------------------------- */
function renderIncomes() {
  const tbody = document.getElementById("incomes-body");
  if (!tbody) return;
  if (!state.incomes.length) {
    tbody.innerHTML = "<tr><td colspan='6'>No incomes yet.</td></tr>";
    return;
  }
  tbody.innerHTML = state.incomes
    .slice()
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(i => `
      <tr>
        <td>${escapeHtml(i.name)}</td>
        <td>${currency.format(i.income)}</td>
        <td>${escapeHtml(i.freq)}</td>
        <td>${escapeHtml(i.nextpay || "-")}</td>
        <td>${escapeHtml(String(i.tax || 0))}%</td>
        <td>
          <button class="btn btn-secondary" onclick="editIncome(${i.id})">Edit</button>
          <button class="btn btn-danger" onclick="deleteIncome(${i.id})">Delete</button>
        </td>
      </tr>
    `).join("");
}



/* ---------------------------
   Bill account & owner selects
   --------------------------- */
function renderBillAccountOptions() {
  const sel = document.getElementById("b-account");
  if (!sel) return;
  sel.innerHTML = ACCOUNTS.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
}

function renderBillOwnerOptions() {
  const sel = document.getElementById("b-owner");
  if (!sel) return;
  const options = [{ value: "Shared", label: "Shared" }].concat(
    state.incomes.map(i => ({ value: i.name, label: i.name }))
  );
  sel.innerHTML = options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
}

/* ---------------------------
   Bills: add / delete / edit / toggle paid
   --------------------------- */
function addBill() {
  const name = (document.getElementById("b-name").value || "").trim();
  const amt = parseFloat(document.getElementById("b-amt").value) || 0;
  const due = parseInt(document.getElementById("b-due").value) || 1;
  const account = document.getElementById("b-account").value || ACCOUNTS[0];
  const owner = document.getElementById("b-owner").value || "Shared";

  if (!name || amt <= 0) {
    showToast("Please provide a name and a positive amount", true);
    return;
  }
  if (isNaN(due) || due < 1 || due > 31) {
    showToast("Due day must be between 1 and 31", true);
    return;
  }

  state.bills.push({ id: Date.now(), name, amt, due, account, owner, paid: false });

  document.getElementById("b-name").value = "";
  document.getElementById("b-amt").value = "";
  document.getElementById("b-due").value = "";

  save();
  showToast("Bill added");
}

function deleteBill(id) {
  state.bills = state.bills.filter(b => b.id !== id);
  save();
  showToast("Bill removed");
}

function togglePaid(billId, checked) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  bill.paid = !!checked;
  // Save and re-render so running totals update immediately
  save();
}

/* ---------------------------
   Reset all paid flags
   --------------------------- */
function resetAllPaidFlags() {
  state.bills.forEach(b => { b.paid = false; });
  save();
  showToast("All Paid flags cleared");
}

/* Ensure Reset Paid button exists in Data Management area */
function ensureResetPaidButton() {
  const label = document.getElementById("data-management-label");
  if (!label) return;
  const section = label.closest(".section");
  if (!section) return;
  let row = section.querySelector(".row");
  if (!row) {
    row = document.createElement("div");
    row.className = "row";
    section.appendChild(row);
  }
  if (document.getElementById("reset-paid-btn")) return;

  const btn = document.createElement("button");
  btn.id = "reset-paid-btn";
  btn.className = "btn btn-secondary";
  btn.type = "button";
  btn.textContent = "Reset Paid";
  btn.style.marginLeft = "8px";
  btn.onclick = () => {
    if (!confirm("Clear all Paid checkboxes? This will mark all bills as unpaid.")) return;
    resetAllPaidFlags();
  };
  row.appendChild(btn);
}

/* ---------------------------
   Pay date helper for any month/year
   - getPayDatesForMonth(inc, year, month)
   - month is 0-based
   - Simple stepping: biweekly = anchor + n*14 days
   --------------------------- */
function getPayDatesForMonth(inc, year, month) {
  const dates = [];
  if (!inc || !inc.nextpay) return dates;

  // parse anchor nextpay as local date (YYYY-MM-DD)
  let anchor;
  try {
    anchor = new Date(inc.nextpay + "T00:00:00");
    if (isNaN(anchor.getTime())) throw new Error("invalid date");
  } catch (e) {
    return dates;
  }

  // semimonthly: anchor day and anchor day + 15 (clamped)
  if (inc.freq === "semimonthly") {
    const day = anchor.getDate();
    const first = new Date(year, month, day);
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    const secondDay = Math.min(day + 15, lastDayOfMonth);
    const second = new Date(year, month, secondDay);
    [first, second].forEach(d => {
      if (d.getMonth() === month && d.getFullYear() === year) dates.push(new Date(d));
    });
    return dates.sort((a,b)=>a-b);
  }

  // weekly/biweekly/monthly: step in days anchored to nextpay
  const stepDays = { weekly: 7, biweekly: 14, monthly: 30 }[inc.freq] || 14;

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);

  // Start from anchor and move backward until before or equal to monthStart
  let d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  let safety = 0;
  while (d.getTime() > monthStart.getTime() && safety < 1000) {
    d = new Date(d.getTime() - stepDays * 86400000);
    safety++;
    if (d.getFullYear() < year - 5) break;
  }

  // Move forward collecting dates in target month
  safety = 0;
  while (d.getTime() <= monthEnd.getTime() && safety < 1000) {
    if (d.getMonth() === month && d.getFullYear() === year) {
      dates.push(new Date(d));
    }
    d = new Date(d.getTime() + stepDays * 86400000);
    safety++;
    if (d.getFullYear() > year + 5) break;
  }

  return dates.sort((a,b)=>a-b);
}

/* ---------------------------
   Bills tab: renderBills (updated column labels & mapping)
   - New header: Item | Amount | Day | Account | Owner | Actions
   --------------------------- */
function renderBills() {
  const tbody = document.getElementById("bills-body");
  if (!tbody) return;

  // Update the table header for the Bills table if present
  const billsTable = tbody.closest("table");
  if (billsTable) {
    const thead = billsTable.querySelector("thead");
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th>Item</th>
          <th>Amount</th>
          <th>Day</th>
          <th>Account</th>
          <th>Owner</th>
          <th></th>
        </tr>
      `;
    }
  }

  // If no bills and no incomes, show placeholder
  if (!state.bills.length && !state.incomes.length) {
    tbody.innerHTML = "<tr><td colspan='6'>No incomes or bills yet.</td></tr>";
    return;
  }

  // Build rows: show incomes first (as Amount rows) then bills
  const incomeRows = state.incomes
    .slice()
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(i => {
      const amount = currency.format(i.income);
      const day = i.nextpay ? escapeHtml(i.nextpay) : "-";
      return `
        <tr>
          <td>${escapeHtml(i.name)}</td>
          <td class="amt-in">${amount}</td>
          <td>${day}</td>
          <td></td>
          <td>${escapeHtml(i.name)}</td>
          <td>
            <button class="btn btn-secondary" onclick="editIncome(${i.id})">Edit</button>
          </td>
        </tr>
      `;
    });

  const billRows = state.bills
    .slice()
    .sort((a,b) => a.due - b.due || a.name.localeCompare(b.name))
    .map(b => {
      const amt = currency.format(b.amt);
      const day = escapeHtml(String(b.due));
      const accountCol = escapeHtml(b.account || "");
      const ownerCol = escapeHtml(b.owner || "Shared");
      return `
        <tr>
          <td>${escapeHtml(b.name)}</td>
          <td class="amt-out">${amt}</td>
          <td>${day}</td>
          <td>${accountCol}</td>
          <td>${ownerCol}</td>
          <td>
            <button class="btn btn-secondary" onclick="editBill(${b.id})">Edit</button>
            <button class="btn btn-danger" onclick="deleteBill(${b.id})">X</button>
          </td>
        </tr>
      `;
    });

  tbody.innerHTML = incomeRows.concat(billRows).join("") || "<tr><td colspan='6'>No incomes or bills yet.</td></tr>";
}

/* ---------------------------
   Flow controls: month/year selectors
   - Renders into #flow-controls or inserts above #flow-section / #tab-flow
   --------------------------- */
function renderFlowControls() {
  let container = document.getElementById("flow-controls");
  if (!container) {
    const flowSection = document.getElementById("flow-section") || document.getElementById("tab-flow") || document.getElementById("tab-flow-section");
    if (flowSection) {
      container = document.createElement("div");
      container.id = "flow-controls";
      container.className = "row";
      flowSection.insertBefore(container, flowSection.firstChild);
    } else {
      container = document.createElement("div");
      container.id = "flow-controls";
      container.className = "row";
      document.body.insertBefore(container, document.body.firstChild);
    }
  }

  // Build month select
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthSel = document.createElement("select");
  monthSel.id = "flow-month";
  monthSel.style.marginRight = "8px";
  monthSel.setAttribute("aria-label","Flow month");
  monthNames.forEach((m, idx) => {
    const opt = document.createElement("option");
    opt.value = idx;
    opt.textContent = m;
    if (idx === flowSelectedMonth) opt.selected = true;
    monthSel.appendChild(opt);
  });

  // Build year select (range: currentYear-2 .. currentYear+2)
  const yearSel = document.createElement("select");
  yearSel.id = "flow-year";
  yearSel.style.marginRight = "8px";
  yearSel.setAttribute("aria-label","Flow year");
  const now = new Date();
  const base = now.getFullYear();
  for (let y = base - 2; y <= base + 2; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = String(y);
    if (y === flowSelectedYear) opt.selected = true;
    yearSel.appendChild(opt);
  }

  container.innerHTML = "";
  const label = document.createElement("div");
  label.style.display = "inline-block";
  label.style.marginRight = "8px";
  label.style.alignSelf = "center";
  label.textContent = "Flow month:";
  container.appendChild(label);
  container.appendChild(monthSel);
  container.appendChild(yearSel);

  monthSel.onchange = () => {
    flowSelectedMonth = parseInt(monthSel.value, 10);
    renderFlow();
  };
  yearSel.onchange = () => {
    flowSelectedYear = parseInt(yearSel.value, 10);
    renderFlow();
  };
}

/* ---------------------------
   Chronological Cash Flow (running totals per account, Paid checkboxes)
   - Uses flowSelectedMonth / flowSelectedYear
   - Date column removed (only Day shown)
   --------------------------- */
function renderFlow() {
  // Ensure controls exist
  renderFlowControls();

  const flowBody = document.getElementById("flow-body");
  if (!flowBody) return;

  // Update header if present (Date column removed)
  const flowTable = flowBody.closest("table");
  if (flowTable) {
    const thead = flowTable.querySelector("thead");
    if (thead) {
      thead.innerHTML = `
        <tr>
          <th>Day</th>
          <th>Event</th>
          <th>In</th>
          <th>Out</th>
          ${ACCOUNTS.map(a => `<th>${escapeHtml(a)} (bills)</th>`).join("")}
          <th>Owner</th>
          <th>Paid</th>
          <th></th>
        </tr>
      `;
    }
  }

  const year = flowSelectedYear;
  const month = flowSelectedMonth; // 0-based

  const events = [];

  // incomes -> one event per paycheck date for selected month/year
  state.incomes.forEach(inc => {
    const dates = getPayDatesForMonth(inc, year, month);
    if (dates.length) {
      dates.forEach(d => {
        events.push({
          day: d.getDate(),
          type: "in",
          label: inc.name,
          amount: inc.income,
          owner: inc.name,
          account: "USAA",
          sourceId: inc.id,
          dateObj: d
        });
      });
    } else {
      // placeholder row (no date in selected month)
      events.push({
        day: null,
        type: "in",
        label: inc.name,
        amount: inc.income,
        owner: inc.name,
        account: "USAA",
        sourceId: inc.id,
        dateObj: null
      });
    }
  });

  // bills -> event on the due day for selected month/year
  state.bills.forEach(b => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const day = Math.min(Math.max(1, Number(b.due) || 1), lastDay);
    events.push({
      day,
      type: "out",
      label: b.name,
      amount: -Math.abs(b.amt),
      owner: b.owner || "Shared",
      account: b.account || ACCOUNTS[0],
      sourceId: b.id,
      paid: !!b.paid,
      dateObj: new Date(year, month, day)
    });
  });

  // sort: dated events by date ascending, undated last; incomes before outs on same day
  events.sort((a, b) => {
    const aTime = a.dateObj ? a.dateObj.getTime() : Infinity;
    const bTime = b.dateObj ? b.dateObj.getTime() : Infinity;
    if (aTime !== bTime) return aTime - bTime;
    if (a.type === b.type) return 0;
    return a.type === "in" ? -1 : 1;
  });

  // running totals per account (only unpaid bills)
  const running = {};
  ACCOUNTS.forEach(a => running[a] = 0);

  // Build rows: update running totals when encountering an unpaid out event (include current row)
  const rows = events.map(e => {
    if (e.type === "out") {
      const bill = state.bills.find(b => b.id === e.sourceId);
      const isPaid = bill ? !!bill.paid : !!e.paid;
      if (!isPaid) {
        const acct = e.account || ACCOUNTS[0];
        if (ACCOUNTS.includes(acct)) running[acct] += Math.abs(e.amount);
      }
    }

    const acctCells = ACCOUNTS.map(a => `<td>${currency.format(running[a])}</td>`).join("");

    if (e.type === "in") {
      return `
        <tr>
          <td>${e.day === null ? "-" : e.day}</td>
          <td>${escapeHtml(e.label)}</td>
          <td class="amt-in">${currency.format(e.amount)}</td>
          <td></td>
          ${acctCells}
          <td>${escapeHtml(e.owner || "")}</td>
          <td></td>
          <td></td>
        </tr>
      `;
    } else {
      const bill = state.bills.find(b => b.id === e.sourceId) || {};
      const isPaid = !!bill.paid;
      const checkbox = `<input type="checkbox" ${isPaid ? "checked" : ""} onchange="togglePaid(${e.sourceId}, this.checked)" aria-label="Mark bill paid">`;
      return `
        <tr>
          <td>${e.day}</td>
          <td>${escapeHtml(e.label)}</td>
          <td></td>
          <td class="amt-out">-${currency.format(Math.abs(e.amount))}</td>
          ${acctCells}
          <td>${escapeHtml(e.owner || "")}</td>
          <td style="text-align:center">${checkbox}</td>
          <td><button class="btn btn-secondary" onclick="editBill(${e.sourceId})">Edit</button> <button class="btn btn-danger" onclick="deleteBill(${e.sourceId})">X</button></td>
        </tr>
      `;
    }
  }).join("");

  flowBody.innerHTML = rows || "<tr><td colspan='" + (4 + ACCOUNTS.length) + "'>No flow events for selected month.</td></tr>";
}

/* ---------------------------
   Result tab
   - Assigned bills now sum by owner (regardless of account)
   - Paid checkbox does not affect assigned totals
   --------------------------- */
function billsInRange(start, end) {
  return state.bills
    .filter(b => b.due >= start && b.due <= end && !b.paid)
    .reduce((s, b) => s + b.amt, 0);
}

function assignedByOwner(ownerName) {
  // Sum all bills assigned to ownerName regardless of account and regardless of paid status
  return state.bills
    .filter(b => (b.owner || "Shared") === ownerName)
    .reduce((s, b) => s + (Number(b.amt) || 0), 0);
}

function renderResult() {
  const incomesMonthly = state.incomes.map(i => ({ name: i.name, monthlyNet: monthlyNetForIncome(i) }));

  let html = "";
  incomesMonthly.forEach(im => {
    const assigned = assignedByOwner(im.name); // sum by owner, ignore account and paid
    html += `<div class="metric"><div class="metric-label">${escapeHtml(im.name)} monthly net</div><div class="metric-value">${currency.format(im.monthlyNet)}</div></div>`;
    html += `<div class="metric"><div class="metric-label">${escapeHtml(im.name)} assigned bills</div><div class="metric-value">${currency.format(assigned)}</div></div>`;
    html += `<div class="metric"><div class="metric-label">${escapeHtml(im.name)} remaining</div><div class="metric-value">${currency.format(im.monthlyNet - assigned)}</div></div>`;
  });

  const first15 = billsInRange(1,15);
  const lastHalf = billsInRange(16,31);
  html += `<div class="metric"><div class="metric-label">Bills 1-15 (unpaid)</div><div class="metric-value">${currency.format(first15)}</div></div>`;
  html += `<div class="metric"><div class="metric-label">Bills 16-EOM (unpaid)</div><div class="metric-value">${currency.format(lastHalf)}</div></div>`;

  const el = document.getElementById("result-summary");
  if (el) el.innerHTML = html;
}

/* ---------------------------
   Export / Import (robust)
   - Export filename uses local machine time in MMMDDYYYYHHMM (24-hour) format
   --------------------------- */
function exportData() {
  const now = new Date();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[now.getMonth()];
  const day = String(now.getDate()).padStart(2, "0");
  const year = now.getFullYear();
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const filename = `${mon}${day}${year}${hour}${minute}.json`;

  const dataStr = JSON.stringify(state, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Export started: ${filename}`);
}

function importData(file) {
  if (!file) {
    console.error("No file provided to importData");
    showToast("No file selected", true);
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    let raw = reader.result;
    try {
      if (raw && raw.charCodeAt && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      raw = (raw || "").trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error("JSON.parse error:", parseErr.message);
        showToast("Import failed: invalid JSON (see console)", true);
        return;
      }

      // Migrate legacy p1/p2 into incomes if needed
      if (!Array.isArray(parsed.incomes) && (parsed.p1 || parsed.p2)) {
        const incomes = [];
        if (parsed.p1 && (parsed.p1.name || parsed.p1.income)) {
          incomes.push({
            id: parsed.p1.id || (Date.now() + 1),
            name: parsed.p1.name || "Person 1",
            income: Number(parsed.p1.income) || 0,
            freq: parsed.p1.freq || "biweekly",
            nextpay: parsed.p1.nextpay || "",
            tax: Number(parsed.p1.tax) || 0
          });
        }
        if (parsed.p2 && (parsed.p2.name || parsed.p2.income)) {
          incomes.push({
            id: parsed.p2.id || (Date.now() + 2),
            name: parsed.p2.name || "Person 2",
            income: Number(parsed.p2.income) || 0,
            freq: parsed.p2.freq || "biweekly",
            nextpay: parsed.p2.nextpay || "",
            tax: Number(parsed.p2.tax) || 0
          });
        }
        parsed.incomes = incomes;
        delete parsed.p1;
        delete parsed.p2;
      }

      if (!Array.isArray(parsed.incomes)) parsed.incomes = [];
      if (!Array.isArray(parsed.bills)) parsed.bills = [];

      parsed.incomes = parsed.incomes.map(i => ({
        id: i.id || (Date.now() + Math.floor(Math.random() * 1000)),
        name: String(i.name || "Income"),
        income: Number(i.income) || 0,
        freq: i.freq || "biweekly",
        nextpay: i.nextpay || "",
        tax: Number(i.tax) || 0
      }));

      parsed.bills = parsed.bills.map(b => ({
        id: b.id || (Date.now() + Math.floor(Math.random() * 1000)),
        name: String(b.name || "Bill"),
        amt: Number(b.amt || b.amount || 0),
        due: Number(b.due) || 1,
        account: ACCOUNTS.includes(b.account) ? b.account : ACCOUNTS[0],
        owner: b.owner || "Shared",
        paid: !!b.paid
      }));

      state = Object.assign({}, state, {
        incomes: parsed.incomes,
        bills: parsed.bills
      });

      try { localStorage.setItem("hb-state5", JSON.stringify(state)); } catch (e) { console.warn("localStorage set failed", e); }
      applyState();
      renderIncomes();
      renderBillAccountOptions();
      renderBillOwnerOptions();
      renderBills();
      renderFlow();
      renderResult();

      console.info("Import successful");
      showToast("Import successful");
    } catch (err) {
      console.error("Import failed:", err);
      showToast("Import failed: see console", true);
    }
  };

  reader.onerror = (e) => {
    console.error("File read error", e);
    showToast("Import failed: file read error", true);
  };

  reader.readAsText(file);
}

/* ---------------------------
   Startup
   --------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  try {
    initAuth();
  } catch (err) {
    console.error("Initial auth/load failed:", err);
  }
});