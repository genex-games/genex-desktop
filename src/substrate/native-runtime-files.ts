/**
 * The files the toolchain store supplies beside a Windows or Linux game, from the store's ANGLE
 * for the destination: one table each, read by the gates, the run folders, the exports, the cross
 * targets and the Windows signing step. File names, in the order every reader lists them.
 *
 * A Rust · wgpu game uses no ANGLE: on Linux it ships only the software Vulkan files
 * ({@link LinuxVulkanFile}), which the `swiftshader-linux` component carries split out of the
 * ANGLE artifact, and on Windows nothing (D3D12, DXGI and FXC's `d3dcompiler_47.dll` are System32's).
 */

/** The files the store supplies beside a Windows game: ANGLE (D3D11) and Microsoft's shader compiler. */
export const WindowsRuntimeFile = {
  Egl: "libEGL.dll",
  Gles: "libGLESv2.dll",
  D3dCompiler: "d3dcompiler_47.dll",
} as const;
export type WindowsRuntimeFile = (typeof WindowsRuntimeFile)[keyof typeof WindowsRuntimeFile];

/** ANGLE's own libraries beside a Linux raylib game (EGL and GLES over Vulkan). */
export const LinuxAngleFile = {
  Egl: "libEGL.so",
  Gles: "libGLESv2.so",
} as const;
export type LinuxAngleFile = (typeof LinuxAngleFile)[keyof typeof LinuxAngleFile];

/**
 * The software Vulkan beside a Linux game, for players without a Vulkan 1.1 driver: the Vulkan
 * loader, SwiftShader and its ICD manifest. A raylib game ships them inside ANGLE's set; a Rust
 * game ships them alone, from the `swiftshader-linux` component.
 */
export const LinuxVulkanFile = {
  VulkanLoader: "libvulkan.so.1",
  SwiftShader: "libvk_swiftshader.so",
  SwiftShaderIcd: "vk_swiftshader_icd.json",
} as const;
export type LinuxVulkanFile = (typeof LinuxVulkanFile)[keyof typeof LinuxVulkanFile];

/**
 * The files the store supplies beside a Linux raylib game: ANGLE (Vulkan), the Vulkan loader ANGLE's
 * build ships, and SwiftShader with its ICD manifest for players without a Vulkan 1.1 driver.
 */
export const LinuxRuntimeFile = { ...LinuxAngleFile, ...LinuxVulkanFile } as const;
export type LinuxRuntimeFile = (typeof LinuxRuntimeFile)[keyof typeof LinuxRuntimeFile];

/** One pinned file: its SHA-256 and size in bytes. */
export interface PinnedFile {
  readonly sha256: string;
  readonly size: number;
}

/**
 * The software Vulkan files' pins: the bytes of ANGLE's Linux build `c5bf49e78850`
 * (`native/angle/bundle-lock.json`, target `linux-x64-vulkan`), as its `manifest.json` lists them.
 * The `swiftshader-linux` component split out of that artifact (`toolchain-store/swiftshader-bundle.ts`,
 * pinned as `swiftshader` in the same lock) must carry exactly these bytes, so a raylib and a Rust
 * Linux game ship the same software Vulkan.
 */
export const LINUX_VULKAN_FILE_PINS = {
  [LinuxVulkanFile.VulkanLoader]: {
    sha256: "efd7e19794208a7479d648e79d0d93729e03f8fa5de0410cab965d3a34a6c34b",
    size: 922_928,
  },
  [LinuxVulkanFile.SwiftShader]: {
    sha256: "45ce6204bf5a4fb80403b8a4765e6cc00cc6fe1dc2f11dfb3f860c29398557cb",
    size: 6_470_856,
  },
  [LinuxVulkanFile.SwiftShaderIcd]: {
    sha256: "c9eef28b6b984fec220ef0abfecc40b502d46946706e47bfe97707027cb818bd",
    size: 107,
  },
} as const satisfies Record<LinuxVulkanFile, PinnedFile>;
