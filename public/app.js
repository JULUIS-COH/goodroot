const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const grid = document.querySelector("#campaign-grid");
const searchInput = document.querySelector("#campaign-search");
const filterLabel = document.querySelector("#active-filters");
const emptyState = document.querySelector("#empty-state");
const toast = document.querySelector("#toast");
let selectedCategory = "All causes";
let toastTimer;

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function campaignCard(campaign) {
  const progress = Math.min(100, Math.round((Number(campaign.raised) / Number(campaign.goal)) * 100) || 0);
  return `<article class="campaign-card">
    <a class="campaign-image campaign-image-link" href="campaign.html?id=${encodeURIComponent(campaign.id)}" aria-label="Read ${escapeText(campaign.title)}">
      <img src="${escapeText(campaign.image)}" alt="" loading="lazy" decoding="async">
      <span class="image-tint"></span><span class="campaign-category">${escapeText(campaign.category)}</span>
      ${campaign.featured ? `<span class="sample-badge">Example</span>` : ""}
    </a>
    <div class="campaign-body">
      <h3 class="campaign-title"><a href="campaign.html?id=${encodeURIComponent(campaign.id)}">${escapeText(campaign.title)}</a></h3>
      <p class="campaign-organizer">Organized by ${escapeText(campaign.organizer)}</p>
      <p class="campaign-story">${escapeText(campaign.story)}</p>
      <div class="progress-track" role="progressbar" aria-label="Fundraising progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="campaign-stats"><span><strong>${currency.format(campaign.raised)}</strong> raised</span><span>${progress}% of ${currency.format(campaign.goal)}</span></div>
      <div class="campaign-footer"><span class="supporters"><strong>${Number(campaign.supporters) || 0}</strong> supporters</span><a class="view-campaign" href="campaign.html?id=${encodeURIComponent(campaign.id)}">See the story <span aria-hidden="true">→</span></a></div>
    </div>
  </article>`;
}

function showError(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4500);
}

async function loadCampaigns() {
  const query = searchInput.value.trim();
  const parameters = new URLSearchParams();
  if (selectedCategory !== "All causes") parameters.set("category", selectedCategory);
  if (query) parameters.set("q", query);
  try {
    const response = await fetch(`/api/campaigns?${parameters.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load fundraisers.");
    const campaigns = payload.campaigns;
    grid.innerHTML = campaigns.map(campaignCard).join("");
    grid.hidden = campaigns.length === 0;
    emptyState.hidden = campaigns.length > 0;
    emptyState.querySelector("h3").textContent = "No fundraisers found just yet";
    emptyState.querySelector("p").textContent = "Try another search or choose a different cause.";
    filterLabel.textContent = query || selectedCategory !== "All causes"
      ? `${campaigns.length} ${campaigns.length === 1 ? "fundraiser" : "fundraisers"}${selectedCategory !== "All causes" ? ` · ${selectedCategory}` : ""}${query ? ` matching “${query}”` : ""}`
      : "";
  } catch (error) {
    grid.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector("h3").textContent = "Fundraisers are unavailable";
    emptyState.querySelector("p").textContent = error instanceof Error ? error.message : "Please try again in a moment.";
    showError("Could not connect to Goodroot. Start the server and try again.");
  }
}

document.querySelectorAll(".category-pill").forEach((button) => {
  button.addEventListener("click", () => {
    selectedCategory = button.dataset.category || "All causes";
    document.querySelectorAll(".category-pill").forEach((pill) => pill.classList.toggle("selected", pill === button));
    loadCampaigns();
  });
});
searchInput.addEventListener("input", loadCampaigns);
document.querySelector('[data-action="clear-filters"]')?.addEventListener("click", () => {
  searchInput.value = "";
  selectedCategory = "All causes";
  document.querySelectorAll(".category-pill").forEach((pill) => pill.classList.toggle("selected", pill.dataset.category === selectedCategory));
  loadCampaigns();
});
loadCampaigns();
