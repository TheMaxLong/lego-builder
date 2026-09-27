#!/bin/sh
# Fetches the pinned three.js files into app/vendor/three (not kept in git).
set -e
V=0.186.1
D="$(cd "$(dirname "$0")/.." && pwd)/app/vendor/three"
B="https://cdn.jsdelivr.net/npm/three@$V"
mkdir -p "$D/addons"
curl -sSfo "$D/three.module.js" "$B/build/three.module.js"
curl -sSfo "$D/three.core.js" "$B/build/three.core.js"
for f in loaders/LDrawLoader.js controls/OrbitControls.js controls/TransformControls.js environments/RoomEnvironment.js \
  postprocessing/EffectComposer.js postprocessing/RenderPass.js postprocessing/GTAOPass.js postprocessing/OutputPass.js \
  postprocessing/OutlinePass.js postprocessing/Pass.js postprocessing/ShaderPass.js postprocessing/MaskPass.js \
  shaders/CopyShader.js shaders/GTAOShader.js shaders/PoissonDenoiseShader.js shaders/OutputShader.js \
  math/SimplexNoise.js materials/LDrawConditionalLineMaterial.js utils/BufferGeometryUtils.js; do
  mkdir -p "$D/addons/$(dirname $f)"
  curl -sSfo "$D/addons/$f" "$B/examples/jsm/$f"
done
echo "$V" > "$D/VERSION"
echo "three.js $V -> $D"
