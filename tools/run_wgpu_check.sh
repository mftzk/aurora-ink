#!/usr/bin/env bash
# Headless WebGPU verification on this box (software Vulkan / lavapipe).
set -e
cd "$(dirname "$0")/.."
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
export VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json
exec /home/ubuntu/.deno/bin/deno run --allow-all tools/wgpu_check.ts
