// Feedback primitives: one toast stack, one modal layer. Every outcome in the app reports
// through here so nothing the user does ends in silence.
//
// The modal is the native <dialog> element — in WebView2 that buys the focus trap, Esc
// handling, backdrop and top-layer stacking for free, which is exactly the set of things
// hand-rolled modals get subtly wrong.

const MAX_TOASTS = 3;
const TOAST_MS = 5000;

/**
 * Pure queue policy, split out for unit tests: newest wins, capped at MAX_TOASTS, and
 * errors stick around until dismissed because they may be the only record of a failure.
 */
export function toastQueueReducer(queue, action) {
  if (action.add) {
    const entry = { sticky: action.add.tone === "error", ...action.add };
    const next = [...queue, entry];
    return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
  }
  if (action.remove !== undefined) return queue.filter((toast) => toast.id !== action.remove);
  return queue;
}

export function toast(message, { tone = "info", actions = [], sticky } = {}) {
  const host = document.getElementById("toast-host");
  if (!host) return () => {};

  const el = document.createElement("div");
  el.className = `toast toast--${tone}`;
  // Errors interrupt politely; everything else waits for the screen reader's next breath.
  el.setAttribute("role", tone === "error" ? "alert" : "status");

  const text = document.createElement("p");
  text.textContent = message;
  el.append(text);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      dismiss();
      action.onClick();
    });
    el.append(button);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", dismiss);
  el.append(close);

  const isSticky = sticky ?? tone === "error";
  if (!isSticky) {
    timer = setTimeout(dismiss, TOAST_MS);
    // A toast the user is reading (or about to click) must not vanish under the pointer.
    el.addEventListener("mouseenter", () => clearTimeout(timer));
    el.addEventListener("mouseleave", () => {
      timer = setTimeout(dismiss, TOAST_MS);
    });
  }

  host.append(el);
  while (host.children.length > MAX_TOASTS) host.firstElementChild.remove();
  return dismiss;
}

function openDialog({ title, body, buttons }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("app-dialog");
    dialog.querySelector("#app-dialog-title").textContent = title;
    dialog.querySelector("#app-dialog-body").textContent = body;

    const row = dialog.querySelector("#app-dialog-buttons");
    row.replaceChildren();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const spec of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = spec.className;
      button.textContent = spec.label;
      button.addEventListener("click", () => {
        settle(spec.id);
        dialog.close();
      });
      row.append(button);
    }
    // Esc or any other out-of-band close resolves null, so callers always get an answer.
    dialog.addEventListener("close", () => settle(null), { once: true });
    dialog.showModal();
    row.lastElementChild?.focus();
  });
}

/** Yes/no question. Resolves true only on explicit confirmation. */
export async function confirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", tone = "default" }) {
  const choice = await openDialog({
    title,
    body,
    buttons: [
      { id: "cancel", label: cancelLabel, className: "secondary" },
      { id: "confirm", label: confirmLabel, className: tone === "danger" ? "danger" : "primary" }
    ]
  });
  return choice === "confirm";
}

/** Multi-choice message. Resolves the chosen action id, or null if dismissed. */
export function messageDialog({ title, body, actions }) {
  return openDialog({
    title,
    body,
    buttons: actions.map((action) => ({
      id: action.id,
      label: action.label,
      className: action.className ?? "secondary"
    }))
  });
}
