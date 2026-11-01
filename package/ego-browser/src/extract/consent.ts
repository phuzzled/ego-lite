/**
 * page.dismissConsent(): close a cookie or consent banner, choosing the
 * privacy-preserving answer ("Reject all", "Necessary only") by default.
 *
 * Known consent platforms are matched first by their stable ids and classes;
 * a text fallback then looks for a reject button inside a dialog-like
 * container. When a banner only offers "Accept", nothing is clicked unless
 * the caller asked for prefer: "accept" (only do that when the user agreed).
 * Rules are data, so they are easy to extend.
 */

export type ConsentPreference = "reject" | "accept";

export type ConsentOptions = {
  prefer?: ConsentPreference;
  timeout?: number;
};

export type ConsentResult = {
  found: boolean;
  action: "reject" | "accept" | "none";
  framework?: string;
  clicked?: string;
  frame?: "main" | "iframe";
  dismissed?: boolean;
  reason?: string;
};

export type ConsentRule = {
  framework: string;
  /** Banner or dialog container; the rule applies when one is visible. */
  container: string;
  reject: string[];
  accept: string[];
  /** Opens a settings panel that has a reject button (OneTrust). */
  settings?: string;
  /** Selectors in the container's open shadow root. */
  shadow?: boolean;
};

export const CONSENT_RULES: readonly ConsentRule[] = [
  {
    framework: "onetrust",
    container: "#onetrust-banner-sdk, #onetrust-pc-sdk",
    reject: [
      "#onetrust-reject-all-handler",
      ".ot-pc-refuse-all-handler",
      "#onetrust-pc-sdk .ot-pc-refuse-all-handler",
    ],
    accept: ["#onetrust-accept-btn-handler", "#accept-recommended-btn-handler"],
    settings: "#onetrust-pc-btn-handler",
  },
  {
    framework: "cookiebot",
    container: "#CybotCookiebotDialog",
    reject: [
      "#CybotCookiebotDialogBodyButtonDecline",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll",
    ],
    accept: [
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "#CybotCookiebotDialogBodyButtonAccept",
    ],
  },
  {
    framework: "didomi",
    container: "#didomi-notice, #didomi-popup, #didomi-host",
    reject: [
      "#didomi-notice-disagree-button",
      ".didomi-continue-without-agreeing",
      "#didomi-popup .didomi-button-highlight + button",
    ],
    accept: ["#didomi-notice-agree-button"],
  },
  {
    framework: "quantcast",
    container: ".qc-cmp2-container, #qc-cmp2-ui",
    reject: [
      '.qc-cmp2-summary-buttons button[mode="secondary"]',
      'button[mode="secondary"][aria-label*="REJECT" i]',
    ],
    accept: ['.qc-cmp2-summary-buttons button[mode="primary"]'],
  },
  {
    framework: "trustarc",
    container: "#truste-consent-track, #consent_blackbar, .truste_box_overlay",
    reject: ["#truste-consent-required", "#truste-consent-decline"],
    accept: ["#truste-consent-button"],
  },
  {
    framework: "usercentrics",
    container: "#usercentrics-root, #usercentrics-cmp-ui",
    reject: ['[data-testid="uc-deny-all-button"]', "#deny"],
    accept: ['[data-testid="uc-accept-all-button"]', "#accept"],
    shadow: true,
  },
  {
    framework: "sourcepoint",
    container: '.message-container, [id^="sp_message_container"], .sp_veil',
    reject: [
      ".sp_choice_type_REJECT_ALL",
      'button[title="Reject all" i]',
      'button[title="Reject" i]',
    ],
    accept: [".sp_choice_type_11", 'button[title="Accept all" i]'],
  },
  {
    framework: "google-funding-choices",
    container: ".fc-consent-root",
    reject: [".fc-cta-do-not-consent", ".fc-secondary-button"],
    accept: [".fc-cta-consent"],
  },
  {
    framework: "osano",
    container: ".osano-cm-dialog, .osano-cm-window",
    reject: [".osano-cm-denyAll", ".osano-cm-button--type_denyAll"],
    accept: [".osano-cm-accept-all", ".osano-cm-button--type_accept"],
  },
  {
    framework: "complianz",
    container: "#cmplz-cookiebanner-container, .cmplz-cookiebanner",
    reject: [".cmplz-deny", ".cmplz-btn.cmplz-deny"],
    accept: [".cmplz-accept"],
  },
  {
    framework: "cookieyes",
    container: ".cky-consent-container, #cookie-law-info-bar",
    reject: [".cky-btn-reject", "#cookie_action_close_header_reject"],
    accept: [".cky-btn-accept", "#cookie_action_close_header"],
  },
  {
    framework: "iubenda",
    container: "#iubenda-cs-banner",
    reject: [".iubenda-cs-reject-btn"],
    accept: [".iubenda-cs-accept-btn"],
  },
  {
    framework: "termly",
    container: '[data-testid="termly-banner"], #termly-code-snippet-support',
    reject: ['[data-tid="banner-decline"]'],
    accept: ['[data-tid="banner-accept"]'],
  },
  {
    framework: "klaro",
    container: ".klaro .cookie-notice, .klaro .cookie-modal",
    reject: [".cn-decline", ".cm-btn-decline"],
    accept: [".cm-btn-accept-all", ".cm-btn-success"],
  },
  {
    framework: "bing",
    container: "#bnp_container, #bnp_cookie_banner",
    reject: ["#bnp_btn_reject", "#bnp_btn_decline"],
    accept: ["#bnp_btn_accept"],
  },
];

/** Button text that means "no non-essential cookies", in common languages. */
export const REJECT_TEXT =
  /^(reject|decline|deny|refuse|disagree)( all| all cookies| cookies| optional cookies| non-essential( cookies)?)?$|^(use |allow |accept )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?$|^continue without (accepting|agreeing|consent)|^(i )?do not (accept|agree|consent)|^no,? thanks$|^(alle )?ablehnen$|^nur (notwendige|erforderliche|essenzielle)( cookies)?$|^tout refuser$|^refuser( tout)?$|^continuer sans accepter$|^rechazar( todo| todas)?$|^rifiuta( tutto| tutti)?$|^(alles )?weigeren$|^rejeitar( tudo)?$|^odrzuć( wszystkie)?$|^avvisa( alla)?$|^afvis( alle)?$/i;

/** Button text that accepts all cookies. */
export const ACCEPT_TEXT =
  /^(accept|allow|agree)( all| all cookies| cookies)?$|^(i )?(agree|accept)$|^(accept|agree) (and|&) (continue|close)$|^got it!?$|^ok(ay)?!?$|^alle akzeptieren$|^akzeptieren$|^tout accepter$|^accepter$|^aceptar( todo| todas)?$|^accetta( tutto| tutti)?$|^(alles )?accepteren$|^aceitar( tudo)?$/i;

/** Runs in each frame. Self-contained. */
export function dismissConsentInFrame(options: {
  prefer: string;
  rules: Array<{
    framework: string;
    container: string;
    reject: string[];
    accept: string[];
    settings?: string;
    shadow?: boolean;
  }>;
  rejectText: string;
  acceptText: string;
  generic: boolean;
}): any {
  const rejectText = new RegExp(options.rejectText, "i");
  const acceptText = new RegExp(options.acceptText, "i");

  function visible(element: Element | null): element is HTMLElement {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0.05
    );
  }

  function label(element: Element): string {
    return (
      (element as HTMLElement).innerText ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (element as HTMLInputElement).value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function first(root: ParentNode, selectors: string[]): HTMLElement | null {
    for (const selector of selectors) {
      let matches: Element[] = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      const hit = matches.find(visible);
      if (hit) return hit as HTMLElement;
    }
    return null;
  }

  function click(element: HTMLElement) {
    element.scrollIntoView({ block: "center" });
    element.click();
  }

  function documents(): Document[] {
    const out: Document[] = [document];
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const inner = (frame as HTMLIFrameElement).contentDocument;
        if (inner && visible(frame)) out.push(inner);
      } catch {
        // Cross-origin frames are handled through their own session.
      }
    }
    return out;
  }

  const want = options.prefer === "accept" ? "accept" : "reject";
  let onlyAccept: string | undefined;

  for (const doc of documents()) {
    for (const rule of options.rules) {
      let containers: Element[] = [];
      try {
        containers = Array.from(doc.querySelectorAll(rule.container));
      } catch {
        continue;
      }
      for (const container of containers) {
        const root: ParentNode =
          rule.shadow && (container as HTMLElement).shadowRoot
            ? ((container as HTMLElement).shadowRoot as ParentNode)
            : container;
        if (!rule.shadow && !visible(container)) continue;
        // The buttons can live outside the container in some versions.
        const scopes: ParentNode[] = [root, doc];
        let target: HTMLElement | null = null;
        for (const scope of scopes) {
          target = first(scope, want === "accept" ? rule.accept : rule.reject);
          if (target) break;
        }
        if (!target && want === "reject" && rule.settings) {
          const settings = first(doc, [rule.settings]);
          if (settings) {
            click(settings);
            return {
              found: true,
              action: "none",
              framework: rule.framework,
              clicked: label(settings),
              retry: true,
            };
          }
        }
        if (target) {
          const text = label(target);
          click(target);
          return {
            found: true,
            action: want,
            framework: rule.framework,
            clicked: text,
          };
        }
        const accept = first(root, rule.accept);
        if (accept) onlyAccept = rule.framework;
      }
    }
  }

  if (options.generic) {
    const containerSelector = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[id*="consent" i]',
      '[class*="consent" i]',
      '[id*="gdpr" i]',
      '[class*="gdpr" i]',
      '[class*="privacy" i]',
      '[id*="privacy" i]',
    ].join(", ");
    for (const doc of documents()) {
      const containers = Array.from(doc.querySelectorAll(containerSelector))
        .filter(visible)
        .filter((element) => {
          if (element === doc.body || element === doc.documentElement) {
            return false;
          }
          const text = (element as HTMLElement).innerText || "";
          // A banner is small; a page wrapper that happens to match is not.
          return (
            text.length < 5000 &&
            /cookie|consent|privacy|gdpr|tracking|datenschutz|personal data/i.test(
              text,
            )
          );
        });
      for (const container of containers) {
        const buttons = Array.from(
          container.querySelectorAll(
            'button, [role="button"], a, input[type="button"], input[type="submit"]',
          ),
        ).filter(visible) as HTMLElement[];
        const pattern = want === "accept" ? acceptText : rejectText;
        const target = buttons.find((button) => pattern.test(label(button)));
        if (target) {
          const text = label(target);
          click(target);
          return {
            found: true,
            action: want,
            framework: "generic",
            clicked: text,
          };
        }
        if (buttons.some((button) => acceptText.test(label(button)))) {
          onlyAccept ||= "generic";
        }
      }
    }
  }

  if (onlyAccept) {
    return {
      found: true,
      action: "none",
      framework: onlyAccept,
      reason:
        want === "reject"
          ? "the banner offers no reject or necessary-only button; nothing was clicked"
          : "no accept button was found",
    };
  }
  return { found: false, action: "none" };
}

/** Runs in the page after a click: is any known banner still visible? */
export function consentStillVisible(options: { container: string }): boolean {
  let containers: Element[] = [];
  try {
    containers = Array.from(document.querySelectorAll(options.container));
  } catch {
    return false;
  }
  return containers.some((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  });
}
