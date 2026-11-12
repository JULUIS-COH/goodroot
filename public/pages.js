const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const toast = () => document.querySelector("#page-toast");
const toastTimeouts = new WeakMap();

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function progressFor(campaign) {
  return Math.min(100, Math.round((Number(campaign.raised) / Number(campaign.goal)) * 100) || 0);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message) {
  let node = toast();
  if (!node) {
    node = document.createElement("div");
    node.id = "page-toast";
    node.className = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("visible");
  window.clearTimeout(toastTimeouts.get(node));
  toastTimeouts.set(node, window.setTimeout(() => node.classList.remove("visible"), 4500));
}

function campaignCard(campaign, { owner = false } = {}) {
  const progress = progressFor(campaign);
  return `<article class="campaign-card">
    <a class="campaign-image campaign-image-link" href="campaign.html?id=${encodeURIComponent(campaign.id)}" aria-label="Read ${escapeText(campaign.title)}">
      <img src="${escapeText(campaign.image)}" alt="" loading="lazy" decoding="async">
      <span class="image-tint"></span><span class="campaign-category">${escapeText(campaign.category)}</span>
      ${campaign.featured ? `<span class="sample-badge">Example</span>` : ""}
    </a>
    <div class="campaign-body">
      <h2 class="campaign-title"><a href="campaign.html?id=${encodeURIComponent(campaign.id)}">${escapeText(campaign.title)}</a></h2>
      <p class="campaign-organizer">Organized by ${escapeText(campaign.organizer)}</p>
      ${owner && campaign.draft ? `<span class="draft-status">Draft · only visible to you</span>` : ""}
      <p class="campaign-story">${escapeText(campaign.story)}</p>
      <div class="progress-track" role="progressbar" aria-label="Fundraising progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="campaign-stats"><span><strong>${currency.format(campaign.raised)}</strong> raised</span><span>${progress}% of ${currency.format(campaign.goal)}</span></div>
      <div class="campaign-footer"><span class="supporters"><strong>${Number(campaign.supporters) || 0}</strong> supporters</span><a class="view-campaign" href="campaign.html?id=${encodeURIComponent(campaign.id)}">See the story <span aria-hidden="true">→</span></a></div>
      ${owner ? `<div class="owner-actions">${campaign.draft ? `<button class="edit-campaign-toggle" type="button" data-resume-campaign="${escapeText(campaign.id)}">Continue fundraiser</button><button class="edit-campaign-toggle" type="button" data-publish-campaign="${escapeText(campaign.id)}">Publish draft</button>` : `<button class="edit-campaign-toggle" type="button" data-edit-campaign="${escapeText(campaign.id)}">Edit fundraiser</button><button class="edit-campaign-toggle" type="button" data-connect-campaign="${escapeText(campaign.id)}">Connect Stripe test payouts</button>`}</div><form class="campaign-edit-form" data-campaign-id="${escapeText(campaign.id)}" hidden>
        <div class="form-field"><label>Title</label><input name="title" maxlength="90" value="${escapeText(campaign.title)}" required></div>
        <div class="form-field"><label>Cause</label><select name="category">${["Community", "Medical", "Education", "Animals", "Environment"].map((item) => `<option ${item === campaign.category ? "selected" : ""}>${item}</option>`).join("")}</select></div>
        <div class="form-field"><label>Goal (USD)</label><input name="goal" type="number" min="1" max="10000000" value="${Number(campaign.goal)}" required></div>
        <div class="form-field"><label>Story</label><textarea name="story" maxlength="1200" required>${escapeText(campaign.story)}</textarea></div>
        <div class="form-field"><label>Location</label><input name="location" maxlength="100" value="${escapeText(campaign.location || "")}"></div>
        <button class="button button-outline" type="submit">Save changes</button>
      </form>` : ""}
    </div>
  </article>`;
}

function setupMobileNavigation() {
  const toggle = document.querySelector(".menu-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const header = document.querySelector(".site-header");
    const expanded = header.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", String(expanded));
  });
  document.querySelectorAll(".main-nav a").forEach((link) => link.addEventListener("click", () => {
    document.querySelector(".site-header").classList.remove("menu-open");
    toggle.setAttribute("aria-expanded", "false");
  }));
}

function renderExplore() {
  const grid = document.querySelector("#page-campaign-grid");
  const search = document.querySelector("#page-search");
  const category = document.querySelector("#page-category");
  const empty = document.querySelector("#page-empty");
  const results = document.querySelector("#page-results");
  let searchTimer;
  const update = async () => {
    const parameters = new URLSearchParams();
    if (search.value.trim()) parameters.set("q", search.value.trim());
    if (category.value !== "All causes") parameters.set("category", category.value);
    grid.setAttribute("aria-busy", "true");
    try {
      const { campaigns } = await api(`/api/campaigns?${parameters.toString()}`);
      grid.innerHTML = campaigns.map((campaign) => campaignCard(campaign)).join("");
      grid.hidden = campaigns.length === 0;
      empty.hidden = campaigns.length > 0;
      results.textContent = `${campaigns.length} ${campaigns.length === 1 ? "fundraiser" : "fundraisers"}${category.value === "All causes" ? "" : ` · ${category.value}`}`;
    } catch (error) {
      grid.hidden = true;
      empty.hidden = false;
      empty.querySelector("h3").textContent = "Could not load fundraisers";
      empty.querySelector("p").textContent = error.message;
    } finally {
      grid.removeAttribute("aria-busy");
    }
  };
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(update, 180);
  });
  category.addEventListener("change", update);
  update();
}

async function renderCampaign() {
  const container = document.querySelector("#campaign-content");
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    location.replace("explore.html");
    return;
  }
  try {
    const { campaign } = await api(`/api/campaigns/${encodeURIComponent(id)}`);
    document.title = `${campaign.title} — Goodroot`;
    const progress = progressFor(campaign);
    const canAccept = Boolean(campaign.can_accept_contributions);
    container.innerHTML = `<a class="back-link" href="explore.html">← All fundraisers</a>
      <div class="campaign-layout">
        <article class="campaign-story-page">
          <img class="campaign-hero-image" src="${escapeText(campaign.image)}" alt="">
          <div class="campaign-story-heading">
            <div class="section-kicker">${campaign.featured ? "EXAMPLE STORY · " : ""}${escapeText(campaign.category)}${campaign.location ? ` · ${escapeText(campaign.location)}` : ""}</div>
            <h1 class="page-title">${escapeText(campaign.title)}</h1>
            <p class="campaign-organizer">Organized by <strong>${escapeText(campaign.organizer)}</strong></p>
          </div>
          <div class="story-section"><h2>Why this matters</h2><p>${escapeText(campaign.story)}</p><p>Every bit of support helps this community take the next step. Share this story with someone who might care, and help good grow from here.</p></div>
          <div class="campaign-update"><span class="update-mark" aria-hidden="true">✳</span><div><strong>${escapeText(campaign.thank_you_note || "Thank you for being here.")}</strong><p>Supporters make it possible for people to turn a hopeful idea into something real.</p></div></div>
          <section class="campaign-updates-section"><div class="section-kicker">FROM THE ORGANIZER</div><h2>Fundraiser updates</h2>${campaign.can_manage ? `<form class="update-form" id="campaign-update-form"><div class="form-field"><label for="update-title">Update title</label><input id="update-title" name="title" maxlength="100" required></div><div class="form-field"><label for="update-body">Share an update</label><textarea id="update-body" name="body" minlength="10" maxlength="2000" required></textarea></div><button class="button button-outline" type="submit">Post update</button></form>` : ""}<div id="campaign-updates" class="campaign-updates-list"><p class="form-hint">Loading updates…</p></div></section>
        </article>
        <aside class="donation-card">
          <div class="donation-total"><strong id="campaign-raised">${currency.format(campaign.raised)}</strong><span>raised of ${currency.format(campaign.goal)} goal</span></div>
          <div class="progress-track" role="progressbar" aria-label="Fundraising progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${progress}%"></div></div>
          <div class="campaign-stats"><span>${progress}% of goal</span><span><strong>${Number(campaign.supporters) || 0}</strong> supporters</span></div>
          ${canAccept
            ? `<button class="button button-dark donation-trigger" type="button" data-open-donation>Contribute securely <span aria-hidden="true">→</span></button>`
            : `<div class="payment-unavailable">This organizer has not finished setting up payouts yet, so contributions are not available.</div>`}
          <button class="share-button" type="button" data-share>↗ &nbsp; Share this fundraiser</button>
          <div class="donor-note">Checkout uses Stripe test mode. No live charges can be made from this release.</div>
          <div class="donation-form-wrap" id="donation-form-wrap" hidden></div>
        </aside>
      </div>
      <section class="related-campaigns"><div class="section-heading"><div><div class="section-kicker">MORE GOOD IN MOTION</div><h2>Stories from the community</h2></div><a class="text-link" href="explore.html">Explore all <span aria-hidden="true">→</span></a></div><div class="campaign-grid" id="related-campaigns"></div></section>`;

    if (canAccept) {
      container.querySelector("[data-open-donation]").addEventListener("click", () => {
        const donationWrap = container.querySelector("#donation-form-wrap");
        container.querySelector("[data-open-donation]").hidden = true;
        donationWrap.hidden = false;
        donationWrap.innerHTML = `<form id="page-donate-form">
          <p class="donation-form-title">Choose your contribution</p>
          <div class="donate-amounts" role="group" aria-label="Choose a contribution amount"><button class="amount-choice" type="button" data-amount="10">$10</button><button class="amount-choice selected" type="button" data-amount="25">$25</button><button class="amount-choice" type="button" data-amount="50">$50</button><button class="amount-choice" type="button" data-amount="100">$100</button></div>
          <div class="form-field"><label for="donate-amount">Amount (USD)</label><input id="donate-amount" name="amount" type="number" min="1" max="999999" step="1" value="25" required></div>
          <div class="form-field"><label for="donor-name">Your name</label><input id="donor-name" name="name" maxlength="60" required></div>
          <div class="form-field"><label for="donor-email">Email address</label><input id="donor-email" name="email" type="email" maxlength="254" required></div>
          <button class="button button-dark modal-submit" type="submit">Continue to Stripe test checkout</button>
          <p class="modal-footnote">Stripe test mode only. No live payment will be collected.</p>
        </form>`;
        donationWrap.querySelector("#donor-name").focus();
        donationWrap.querySelectorAll(".amount-choice").forEach((button) => button.addEventListener("click", () => {
          donationWrap.querySelector("#donate-amount").value = button.dataset.amount;
          donationWrap.querySelectorAll(".amount-choice").forEach((item) => item.classList.toggle("selected", item === button));
        }));
        donationWrap.querySelector("#page-donate-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          if (!form.reportValidity()) return;
          const data = new FormData(form);
          const amount = Number(data.get("amount"));
          if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999999) {
            showToast("Enter a whole-dollar amount between $1 and $999,999.");
            return;
          }
          const submit = form.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            const result = await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/checkout`, {
              method: "POST",
              body: JSON.stringify({ amount, name: data.get("name"), email: data.get("email") }),
            });
            location.assign(result.checkoutUrl);
          } catch (error) {
            showToast(error.message);
            submit.disabled = false;
          }
        });
      });
    }

    container.querySelector("[data-share]").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        showToast("Fundraiser link copied.");
      } catch {
        showToast("Copy the page address from your browser to share this fundraiser.");
      }
    });

    const parameters = new URLSearchParams();
    parameters.set("category", campaign.category);
    const related = await api(`/api/campaigns?${parameters.toString()}`);
    container.querySelector("#related-campaigns").innerHTML = related.campaigns
      .filter((item) => item.id !== campaign.id)
      .slice(0, 3)
      .map((item) => campaignCard(item))
      .join("");

    const updatesContainer = container.querySelector("#campaign-updates");
    const updatesResult = await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/updates`);
    updatesContainer.innerHTML = updatesResult.updates.length
      ? updatesResult.updates.map((update) => `<article class="campaign-update-entry"><h3>${escapeText(update.title)}</h3><time datetime="${escapeText(update.created_at)}">${new Date(update.created_at).toLocaleDateString("en-US", { dateStyle: "long" })}</time><p>${escapeText(update.body)}</p></article>`).join("")
      : `<p class="form-hint">No updates yet. Check back as this fundraiser grows.</p>`;
    const updateForm = container.querySelector("#campaign-update-form");
    updateForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!updateForm.reportValidity()) return;
      const submit = updateForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(updateForm).entries());
        await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/updates`, {
          method: "POST",
          body: JSON.stringify(values),
        });
        showToast("Your update has been posted.");
        await renderCampaign();
      } catch (error) {
        showToast(error.message);
        submit.disabled = false;
      }
    });

    const paymentStatus = new URLSearchParams(location.search).get("payment");
    if (paymentStatus === "success") {
      showToast("Stripe returned successfully. The contribution will appear once the signed payment confirmation arrives.");
      history.replaceState(null, "", `campaign.html?id=${encodeURIComponent(campaign.id)}`);
    } else if (paymentStatus === "cancelled") {
      showToast("Checkout was cancelled. No contribution was collected.");
      history.replaceState(null, "", `campaign.html?id=${encodeURIComponent(campaign.id)}`);
    }
  } catch (error) {
    container.innerHTML = `<a class="back-link" href="explore.html">← All fundraisers</a><section class="missing-campaign"><div class="section-kicker">FUNDRAISER UNAVAILABLE</div><h1 class="page-title">We couldn't load <em>this story.</em></h1><p class="page-lead">${escapeText(error.message)}</p><a class="button button-dark" href="explore.html">Explore fundraisers <span aria-hidden="true">→</span></a></section>`;
  }
}

function safeReturnPath() {
  const next = new URLSearchParams(location.search).get("next") || "dashboard.html";
  if (/^(start|dashboard)\.html$/.test(next)) return next;
  return "dashboard.html";
}

async function renderAuth() {
  const loginForm = document.querySelector("#login-form");
  const registerForm = document.querySelector("#register-form");
  const message = document.querySelector("#auth-message");
  const title = document.querySelector("#auth-title");
  const description = document.querySelector("#auth-description");
  const switchMode = (mode) => {
    const registering = mode === "register";
    loginForm.hidden = registering;
    registerForm.hidden = !registering;
    title.innerHTML = registering ? "Start your <em>Goodroot account.</em>" : "Good to have <em>you here.</em>";
    description.textContent = registering ? "Create an account to start and manage fundraisers." : "Sign in to manage your fundraisers and payment account.";
    message.textContent = "";
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      const selected = button.dataset.authMode === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  };
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => switchMode(button.dataset.authMode)));
  const existing = await api("/api/auth/me");
  if (existing.user) {
    location.replace(safeReturnPath());
    return;
  }
  for (const [form, endpoint] of [[loginForm, "/api/auth/login"], [registerForm, "/api/auth/register"]]) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      message.textContent = "";
      try {
        const data = new FormData(form);
        const fields = Object.fromEntries(data.entries());
        await api(endpoint, { method: "POST", body: JSON.stringify(fields) });
        location.assign(safeReturnPath());
      } catch (error) {
        message.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  }
}

async function renderStart() {
  let user;
  try {
    ({ user } = await api("/api/auth/me"));
    if (!user) {
      location.replace(`sign-in.html?next=${encodeURIComponent("start.html")}`);
      return;
    }
    setupSignOut();
    const organizer = document.querySelector("#create-organizer");
    if (organizer && !organizer.value) organizer.value = user.name;
  } catch (error) {
    showToast(error.message);
  }
  const form = document.querySelector("#page-create-form");
  const steps = [...form.querySelectorAll("[data-wizard-step]")];
  const stepTitles = ["YOUR CAUSE", "YOUR GOAL", "FUNDRAISER NAME", "YOUR STORY", "COVER AND REVIEW"];
  const nextButton = form.querySelector("#wizard-next");
  const backButton = form.querySelector("#wizard-back");
  const saveDraftButton = form.querySelector("#wizard-save-draft");
  const publishButton = form.querySelector("#wizard-publish");
  const existingDraftId = new URLSearchParams(location.search).get("draft");
  let currentStep = 0;
  let uploadedImageUrl = "";
  if (existingDraftId) {
    try {
      const { campaign } = await api(`/api/campaigns/${encodeURIComponent(existingDraftId)}`);
      if (!campaign.can_manage || !campaign.draft) throw new Error("This draft is unavailable.");
      const values = {
        category: campaign.category,
        beneficiaryType: campaign.beneficiary_type,
        beneficiaryName: campaign.beneficiary_name,
        location: campaign.location,
        goal: campaign.goal,
        title: campaign.title,
        organizer: campaign.organizer,
        story: campaign.story,
        thankYouNote: campaign.thank_you_note,
        imageUrl: campaign.image,
      };
      for (const [name, value] of Object.entries(values)) {
        const field = form.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
          field.value = String(value ?? "");
        }
      }
      if (campaign.image.startsWith("/uploads/")) {
        uploadedImageUrl = campaign.image;
        form.querySelector("#cover-preview").src = campaign.image;
        form.querySelector("#cover-preview-wrap").hidden = false;
        form.querySelector("#image-upload-status").textContent = "Saved cover image.";
      }
    } catch (error) {
      showToast(error.message);
      location.assign("dashboard.html");
      return;
    }
  }
  const updateReview = () => {
    steps.forEach((step) => { step.disabled = false; });
    const data = new FormData(form);
    const category = String(data.get("category") || "");
    const goal = Number(data.get("goal"));
    form.querySelector("#fundraiser-review").innerHTML = `<div class="section-kicker">REVIEW YOUR FUNDRAISER</div><h3>${escapeText(data.get("title") || "Your fundraiser title")}</h3><p>${escapeText(data.get("story") || "Your story will appear here.")}</p><div class="campaign-stats"><span>${escapeText(category || "Choose a cause")}</span><span>${Number.isFinite(goal) && goal > 0 ? currency.format(goal) : "Set a goal"}</span></div><p class="review-beneficiary">Raising funds for ${escapeText(data.get("beneficiaryName") || "your beneficiary")}${data.get("location") ? ` · ${escapeText(data.get("location"))}` : ""}</p>`;
    steps.forEach((step, index) => { step.disabled = index !== currentStep; });
  };
  const setStep = (index) => {
    currentStep = Math.max(0, Math.min(index, steps.length - 1));
    steps.forEach((step, stepIndex) => {
      const active = stepIndex === currentStep;
      step.hidden = !active;
      step.disabled = !active;
    });
    form.querySelector("#wizard-step-name").textContent = stepTitles[currentStep];
    form.querySelector("#wizard-step-count").textContent = `STEP ${currentStep + 1} OF ${steps.length}`;
    form.querySelector("#wizard-progress-fill").style.width = `${((currentStep + 1) / steps.length) * 100}%`;
    backButton.hidden = currentStep === 0;
    nextButton.hidden = currentStep === steps.length - 1;
    saveDraftButton.hidden = false;
    publishButton.hidden = currentStep !== steps.length - 1;
    if (currentStep === steps.length - 1) updateReview();
    steps[currentStep].querySelector("input,select,textarea")?.focus();
  };
  nextButton.addEventListener("click", () => {
    const activeStep = steps[currentStep];
    if (!activeStep.reportValidity()) return;
    setStep(currentStep + 1);
  });
  backButton.addEventListener("click", () => setStep(currentStep - 1));
  form.querySelector("#beneficiary-type").addEventListener("change", (event) => {
    const name = form.querySelector("#beneficiary-name");
    const organizer = form.querySelector("#create-organizer");
    if (event.currentTarget.value === "self" && organizer.value) name.value = organizer.value;
    name.placeholder = event.currentTarget.value === "self" ? "Your name" : "Name of a person, group, or organization";
  });
  form.querySelector("#create-organizer").addEventListener("input", (event) => {
    const beneficiary = form.querySelector("#beneficiary-name");
    if (form.querySelector("#beneficiary-type").value === "self" && !beneficiary.value) {
      beneficiary.value = event.currentTarget.value;
    }
  });
  form.querySelector("#create-image").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const imageStatus = form.querySelector("#image-upload-status");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      event.currentTarget.value = "";
      showToast("Choose a JPEG, PNG, or WebP image under 5 MB.");
      return;
    }
    imageStatus.textContent = "Uploading your image securely…";
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the selected image."));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the selected image."));
        reader.readAsDataURL(file);
      });
      const response = await api("/api/uploads/images", { method: "POST", body: JSON.stringify({ dataUrl }) });
      uploadedImageUrl = response.imageUrl;
      form.querySelector("#image-url").value = uploadedImageUrl;
      form.querySelector("#cover-preview").src = uploadedImageUrl;
      form.querySelector("#cover-preview-wrap").hidden = false;
      imageStatus.textContent = "Cover image uploaded.";
      updateReview();
    } catch (error) {
      imageStatus.textContent = error.message;
      event.currentTarget.value = "";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    const status = submitter.value === "draft" ? "draft" : "published";
    steps.forEach((step) => { step.disabled = false; });
    const valid = status === "draft" || form.reportValidity();
    const data = valid ? new FormData(form) : undefined;
    steps.forEach((step, index) => {
      step.disabled = index !== currentStep;
      step.hidden = index !== currentStep;
    });
    if (!valid) {
      const invalid = form.querySelector(":invalid");
      const invalidStep = invalid?.closest("[data-wizard-step]");
      if (invalidStep) setStep(Number(invalidStep.dataset.wizardStep) - 1);
      return;
    }
    if (!data) return;
    submitter.disabled = true;
    try {
      const fields = Object.fromEntries(data.entries());
      let campaign;
      if (existingDraftId) {
        const result = await api(`/api/campaigns/${encodeURIComponent(existingDraftId)}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        });
        campaign = result.campaign;
        if (status === "published") {
          ({ campaign } = await api(`/api/campaigns/${encodeURIComponent(existingDraftId)}/publish`, {
            method: "POST",
            body: "{}",
          }));
        }
      } else {
        ({ campaign } = await api("/api/campaigns", {
          method: "POST",
          body: JSON.stringify({ ...fields, status }),
        }));
      }
      if (status === "published") {
        location.assign(`campaign.html?id=${encodeURIComponent(campaign.id)}`);
      } else {
        location.assign(`dashboard.html?draft=${encodeURIComponent(campaign.id)}`);
      }
    } catch (error) {
      if (error.status === 401) {
        location.assign(`sign-in.html?next=${encodeURIComponent("start.html")}`);
        return;
      }
      showToast(error.message);
      submitter.disabled = false;
    }
  });
  setStep(0);
}

async function renderDashboard() {
  const grid = document.querySelector("#dashboard-grid");
  const empty = document.querySelector("#dashboard-empty");
  const summary = document.querySelector("#dashboard-summary");
  const status = document.querySelector("#dashboard-status");
  try {
    const auth = await api("/api/auth/me");
    if (!auth.user) {
      location.replace(`sign-in.html?next=${encodeURIComponent("dashboard.html")}`);
      return;
    }
    setupSignOut();
    const { campaigns } = await api("/api/me/campaigns");
    const raised = campaigns.reduce((total, campaign) => total + Number(campaign.raised), 0);
    const supporters = campaigns.reduce((total, campaign) => total + Number(campaign.supporters), 0);
    summary.innerHTML = `<div class="dashboard-stat"><strong>${campaigns.length}</strong><span>${campaigns.length === 1 ? "fundraiser" : "fundraisers"}</span></div><div class="dashboard-stat"><strong>${currency.format(raised)}</strong><span>raised</span></div><div class="dashboard-stat"><strong>${supporters}</strong><span>supporters</span></div><a class="button button-dark" href="start.html">Start a fundraiser <span aria-hidden="true">↗</span></a>`;
    grid.innerHTML = campaigns.map((campaign) => campaignCard(campaign, { owner: true })).join("");
    grid.hidden = campaigns.length === 0;
    empty.hidden = campaigns.length > 0;
    const statuses = auth.user.hasPayoutAccount ? await Promise.all(campaigns.map(async (campaign) => {
      try {
        return await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/connect-status`);
      } catch {
        return null;
      }
    })) : [];
    if (!auth.user.hasPayoutAccount) {
      status.textContent = "Connect a Stripe Express test account before your fundraisers can accept contributions.";
    } else if (statuses.some((item) => item?.ready)) {
      status.textContent = "Your Stripe test payout account is connected.";
    } else {
      status.textContent = "Your payout account still needs setup in Stripe test mode.";
    }
  } catch (error) {
    status.textContent = error.message;
    if (error.status === 401) location.replace(`sign-in.html?next=${encodeURIComponent("dashboard.html")}`);
  }
}

function setupSignOut() {
  const signInLink = document.querySelector(".header-actions .text-button");
  if (!signInLink || signInLink.dataset.signOutReady) return;
  signInLink.textContent = "Sign out";
  signInLink.href = "#sign-out";
  signInLink.dataset.signOutReady = "true";
  signInLink.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      location.assign("index.html");
    } catch (error) {
      showToast(error.message);
    }
  });
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const resume = target.closest("[data-resume-campaign]");
  if (resume) {
    location.assign(`start.html?draft=${encodeURIComponent(resume.dataset.resumeCampaign)}`);
    return;
  }
  const publish = target.closest("[data-publish-campaign]");
  if (publish) {
    publish.disabled = true;
    try {
      await api(`/api/campaigns/${encodeURIComponent(publish.dataset.publishCampaign)}/publish`, { method: "POST", body: "{}" });
      showToast("Your fundraiser is now published.");
      await renderDashboard();
    } catch (error) {
      showToast(error.message);
      publish.disabled = false;
    }
    return;
  }
  const connect = target.closest("[data-connect-campaign]");
  if (connect) {
    connect.disabled = true;
    try {
      const result = await api(`/api/campaigns/${encodeURIComponent(connect.dataset.connectCampaign)}/connect`, { method: "POST", body: "{}" });
      location.assign(result.url);
    } catch (error) {
      showToast(error.message);
      connect.disabled = false;
    }
    return;
  }
  const edit = target.closest("[data-edit-campaign]");
  if (edit) {
    const form = document.querySelector(`[data-campaign-id="${CSS.escape(edit.dataset.editCampaign)}"]`);
    if (form) form.hidden = !form.hidden;
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches(".campaign-edit-form")) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    await api(`/api/campaigns/${encodeURIComponent(form.dataset.campaignId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    });
    showToast("Fundraiser updated.");
    await renderDashboard();
  } catch (error) {
    showToast(error.message);
    submit.disabled = false;
  }
});

document.querySelectorAll(".current-year").forEach((node) => { node.textContent = String(new Date().getFullYear()); });
setupMobileNavigation();
switch (document.body.dataset.page) {
  case "explore": renderExplore(); break;
  case "campaign": renderCampaign(); break;
  case "start": renderStart(); break;
  case "dashboard": renderDashboard(); break;
  case "signin": renderAuth().catch((error) => { document.querySelector("#auth-message").textContent = error.message; }); break;
}
