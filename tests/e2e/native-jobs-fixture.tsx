import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { NativeJobLimits, NativeJobs } from "../../src/renderer/panels/plugins/NativeJobs.tsx";
import {
  NativeJobState,
  type PluginManifest,
  type PluginNativeJobSummary,
  type PluginNativeResult,
} from "../../src/shared/plugins.ts";

const id = "local-generation";
const manifest: PluginManifest = {
  apiVersion: 3,
  id,
  name: "Local generation",
  version: "1.0.0",
  publisher: "Test",
  description: "Disposable UI fixture",
  backend: "backend.mjs",
  capabilities: ["native-runtime"],
  tools: [],
  actions: [],
  panels: [],
  skills: [],
  settings: [],
  nativeJobs: [
    {
      id: "hunyuan-shape",
      runtime: "python",
      args: [],
      inputs: [],
      values: {},
      outputs: ["shape.glb"],
      timeoutMs: 2100000,
      maxOutputBytes: 1000,
      maxAssetBytes: 4096,
      gpu: true,
    },
  ],
};
const states = [NativeJobState.Running, NativeJobState.Completed, NativeJobState.Failed, NativeJobState.Interrupted];
let jobs: PluginNativeResult[] = states.map((state, index) => ({
  id: `job-${index}`,
  recipe: "hunyuan-shape",
  runtime: "python",
  project: index === 0 ? "Crystal island" : "Model study",
  output: "/fixture",
  files: state === NativeJobState.Completed ? ["shape.glb", "textures/preview.png"] : [],
  stdout:
    state === NativeJobState.Completed ? "Mesh generation complete.\nSaved shape.glb" : "Starting local generation…",
  ...(state === NativeJobState.Failed ? { stderr: "CUDA runtime unavailable" } : {}),
  state,
  createdAt: new Date(Date.now() - (index + 1) * 180000).toISOString(),
  ...(state === NativeJobState.Running || state === NativeJobState.Interrupted
    ? {}
    : { finishedAt: new Date(Date.now() - index * 180000).toISOString() }),
  ...(state === NativeJobState.Interrupted
    ? { reason: "Studio closed before job completion. The job was not replayed." }
    : {}),
  ...(state === NativeJobState.Failed
    ? { reason: "Runtime exited with an error. Check the plugin's runtime setup." }
    : {}),
}));
const calls: Array<{ plugin: string; jobId: string }> = [];
const detailCalls: Array<{ plugin: string; jobId: string }> = [];
let summaryCalls = 0;
let detailsGate: Promise<void> | null = null;
let releaseDetails = () => {};
let detailFailure = "";
let release = () => {};
let fail = false;
Object.assign(window, {
  studio: {
    pluginNativeJobs: async () => {
      summaryCalls++;
      if (fail) throw new Error("Unable to read job records. Reopen the plugin page to retry.");
      return jobs.map(
        ({ id, recipe, runtime, state, project, createdAt, finishedAt }): PluginNativeJobSummary => ({
          id,
          recipe,
          runtime,
          state,
          project,
          createdAt,
          ...(finishedAt ? { finishedAt } : {}),
        }),
      );
    },
    pluginNativeJob: async (plugin: string, jobId: string) => {
      detailCalls.push({ plugin, jobId });
      await detailsGate;
      if (detailFailure === jobId) throw new Error("Unable to load job details. Try again.");
      return structuredClone(jobs.find((job) => job.id === jobId) ?? null);
    },
    pluginCancelNativeJob: (plugin: string, jobId: string) => {
      calls.push({ plugin, jobId });
      return new Promise<boolean>((resolve) => {
        release = () => {
          jobs = jobs.map((job) =>
            job.id === jobId ? { ...job, state: NativeJobState.Cancelled, finishedAt: new Date().toISOString() } : job,
          );
          resolve(true);
        };
      });
    },
  },
  nativeJobsFixture: {
    calls,
    detailCalls,
    summaryCalls: () => summaryCalls,
    setState: (jobId: string, state: NativeJobState, finishedAt?: string) => {
      jobs = jobs.map((job) => (job.id === jobId ? { ...job, state, finishedAt } : job));
    },
    holdDetails: () => {
      detailsGate = new Promise<void>((resolve) => {
        releaseDetails = resolve;
      });
    },
    releaseDetails: () => {
      releaseDetails();
      detailsGate = null;
    },
    failDetails: (jobId: string) => {
      detailFailure = jobId;
    },
    clearDetailFailure: () => {
      detailFailure = "";
    },
    emptyDetails: (jobId: string) => {
      jobs = jobs.map((job) => (job.id === jobId ? { ...job, stdout: "", stderr: "", files: [] } : job));
    },
    release: () => release(),
    fail: () => {
      fail = true;
    },
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
  },
});
initializeAppearance();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <main style={{ padding: 32, maxWidth: 780, margin: "0 auto" }}>
    <h1 style={{ fontSize: 24, marginBottom: 24 }}>Local generation</h1>
    <NativeJobLimits manifest={manifest} />
    <NativeJobs id={id} />
  </main>,
);
