const consent = document.querySelector("#consent");
const cookies = document.querySelector("#cookies");
const save = document.querySelector("#save");
const saved = document.querySelector("#saved");
const extensionApi = globalThis.browser ?? globalThis.chrome;

extensionApi.storage.local.get(["consentVersion", "shareCookies"]).then((values) => {
  consent.checked = values.consentVersion >= 1;
  cookies.checked = Boolean(values.shareCookies);
  consent.disabled = false;
  cookies.disabled = false;
  save.disabled = !consent.checked;
});

consent.addEventListener("change", () => { save.disabled = false; });
save.addEventListener("click", async () => {
  const granted = consent.checked;
  await extensionApi.storage.local.set({
    consentVersion: granted ? 1 : 0,
    enabled: granted,
    shareCookies: granted && cookies.checked
  });
  saved.textContent = granted ? "Saved. You can close this tab." : "Integration disabled.";
});
