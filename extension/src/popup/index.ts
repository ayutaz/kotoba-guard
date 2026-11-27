import { originFromUrl } from "../background/state";
import { readSettings } from "../shared/storage";
import type { RuntimeStatus } from "../shared/types";

const globalToggle = document.querySelector<HTMLInputElement>("#global-toggle");
const siteToggle = document.querySelector<HTMLButtonElement>("#site-toggle");
const manualCheck = document.querySelector<HTMLButtonElement>("#manual-check");
const siteName = document.querySelector<HTMLElement>("#site-name");
const status = document.querySelector<HTMLElement>("#status");
const modelState = document.querySelector<HTMLElement>("#model-state");
const modelName = document.querySelector<HTMLElement>("#model-name");
const detectionCount = document.querySelector<HTMLElement>("#detection-count");
const backendState = document.querySelector<HTMLElement>("#backend-state");

let activeTab: chrome.tabs.Tab | undefined;
let activeOrigin: string | undefined;
let siteEnabled = false;

function setStatus(text: string, error = false): void {
  if (!status) return;
  status.textContent = text;
  status.dataset.error = error ? "true" : "false";
}

function updateSiteButton(): void {
  if (!siteToggle) return;
  siteToggle.disabled = !activeOrigin;
  siteToggle.textContent = siteEnabled
    ? "このサイトを無効にする"
    : "このサイトで有効にする";
}

async function getStatus(): Promise<RuntimeStatus | undefined> {
  try {
    return (await chrome.runtime.sendMessage({
      type: "get-status",
      tabId: activeTab?.id,
    })) as RuntimeStatus;
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  activeTab = (
    await chrome.tabs.query({ active: true, currentWindow: true })
  )[0];
  activeOrigin = originFromUrl(activeTab?.url);
  if (siteName)
    siteName.textContent = activeOrigin
      ? `${activeOrigin} の設定`
      : "このページでは利用できません";
  const settings = await readSettings();
  siteEnabled = activeOrigin
    ? settings.enabledSites.includes(activeOrigin)
    : false;
  if (globalToggle) globalToggle.checked = settings.globalEnabled;
  updateSiteButton();
  const current = await getStatus();
  if (modelState) {
    modelState.textContent = current?.modelReady
      ? "準備完了"
      : current?.lastError
        ? "エラー"
        : "未初期化";
    modelState.dataset.state = current?.modelReady ? "ready" : "idle";
  }
  const revision = current?.modelVersion;
  if (modelName)
    modelName.textContent =
      revision && revision !== "unavailable"
        ? `モデル: ModernBERT 日本語誤字検出 30M（${revision.slice(0, 12)}）`
        : "モデル: ModernBERT 日本語誤字検出 30M（未初期化）";
  if (detectionCount)
    detectionCount.textContent = `このタブの直近の検出: ${current?.detectionCount ?? 0}件`;
  if (backendState)
    backendState.textContent = `バックエンド: ${current?.backend ?? "未初期化"}`;
  if (current?.lastError) setStatus(`推論エラー: ${current.lastError}`, true);
}

globalToggle?.addEventListener("change", async () => {
  const next = globalToggle.checked;
  globalToggle.disabled = true;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "set-global-enabled",
      enabled: next,
    })) as { ok?: boolean } | undefined;
    if (response?.ok !== true) throw new Error("state-failed");
    setStatus(next ? "すべての有効サイトで検出します" : "検出を停止しました");
  } catch {
    globalToggle.checked = !next;
    setStatus("設定を保存できませんでした", true);
  }
  globalToggle.disabled = false;
});

siteToggle?.addEventListener("click", async () => {
  if (!activeOrigin) return;
  siteToggle.disabled = true;
  const next = !siteEnabled;
  try {
    if (next) {
      const granted = await chrome.permissions.request({
        origins: [`${activeOrigin}/*`],
      });
      if (!granted) throw new Error("permission-denied");
    }
    const response = (await chrome.runtime.sendMessage({
      type: "set-site-enabled",
      origin: activeOrigin,
      enabled: next,
    })) as { ok?: boolean; code?: string } | undefined;
    if (response?.ok !== true)
      throw new Error(response?.code ?? "state-failed");
    siteEnabled = next;
    updateSiteButton();
    setStatus(
      siteEnabled ? "このサイトで検出します" : "このサイトの検出を停止しました",
    );
  } catch {
    setStatus(
      next
        ? "サイトへのアクセス許可が必要です"
        : "サイト設定を変更できませんでした",
      true,
    );
  }
  siteToggle.disabled = false;
});

manualCheck?.addEventListener("click", async () => {
  manualCheck.disabled = true;
  setStatus("チェックしています…");
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "manual-check",
      tabId: activeTab?.id,
    })) as { ok?: boolean; code?: string };
    setStatus(
      response?.ok
        ? "チェックを開始しました"
        : "このページではチェックできません",
      !response?.ok,
    );
  } catch {
    setStatus("チェックを開始できませんでした", true);
  }
  manualCheck.disabled = false;
});

void refresh();
