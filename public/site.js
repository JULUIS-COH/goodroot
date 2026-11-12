function closeMobileMenu() {
  const header = document.querySelector(".site-header");
  const toggle = header?.querySelector(".menu-toggle");
  if (!header || !toggle) return;
  header.classList.remove("menu-open");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open menu");
}

function setupSharedHeader() {
  const header = document.querySelector(".site-header");
  const toggle = header?.querySelector(".menu-toggle");
  if (header && toggle) {
    toggle.addEventListener("click", () => {
      const expanded = header.classList.toggle("menu-open");
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? "Close menu" : "Open menu");
    });

    header.querySelectorAll(".main-nav a").forEach((link) => {
      link.addEventListener("click", closeMobileMenu);
    });

    document.addEventListener("click", (event) => {
      if (header.classList.contains("menu-open") && event.target instanceof Node && !header.contains(event.target)) {
        closeMobileMenu();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMobileMenu();
    });
  }

  const actions = header?.querySelector(".header-actions");
  const accountLink = actions?.querySelector(".text-button");
  const primaryAction = actions?.querySelector(".header-cta");
  if (!actions || !accountLink) return;

  const signOutButton = document.createElement("button");
  signOutButton.type = "button";
  signOutButton.className = "text-button account-sign-out";
  signOutButton.textContent = "Sign out";
  signOutButton.hidden = true;
  actions.append(signOutButton);

  signOutButton.addEventListener("click", async () => {
    signOutButton.disabled = true;
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Sign out failed (${response.status}).`);
      }
      location.assign("index.html");
    } catch (error) {
      signOutButton.disabled = false;
      const toast = document.querySelector("#page-toast, #toast");
      if (toast) {
        toast.textContent = error instanceof Error ? error.message : "Could not sign out. Please try again.";
        toast.classList.add("visible");
      } else {
        const notice = document.createElement("p");
        notice.className = "site-error-notice";
        notice.setAttribute("role", "alert");
        notice.textContent = error instanceof Error ? error.message : "Could not sign out. Please try again.";
        document.body.append(notice);
      }
    }
  });

  fetch("/api/auth/me", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Account status unavailable (${response.status}).`);
      return response.json();
    })
    .then(({ user }) => {
      if (user) {
        accountLink.textContent = "My fundraisers";
        accountLink.href = "dashboard.html";
        signOutButton.hidden = false;
        if (primaryAction) {
          primaryAction.textContent = "Start a fundraiser";
          primaryAction.href = "start.html";
        }
      } else {
        accountLink.textContent = "Sign in";
        accountLink.href = "sign-in.html";
        if (primaryAction) {
          primaryAction.textContent = "Start a fundraiser";
          primaryAction.href = "start.html";
        }
      }
    })
    .catch((error) => {
      console.error("Could not load account navigation.", error);
    });
}

function setupSharedFooter() {
  const footer = document.querySelector(".site-footer");
  if (!footer) return;

  if (!footer.querySelector(".footer-nav")) {
    const navigation = document.createElement("nav");
    navigation.className = "footer-nav";
    navigation.setAttribute("aria-label", "Footer navigation");
    navigation.innerHTML = `
      <a href="explore.html">Explore</a>
      <a href="how-it-works.html">How it works</a>
      <a href="start.html">Start a fundraiser</a>
      <a href="dashboard.html">My fundraisers</a>
    `;
    footer.append(navigation);
  }

  footer.querySelectorAll(".footer-copyright .current-year, .footer-copyright #current-year, #current-year")
    .forEach((year) => { year.textContent = String(new Date().getFullYear()); });
}

setupSharedHeader();
setupSharedFooter();
