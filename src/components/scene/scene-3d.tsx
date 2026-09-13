'use client';

/**
 * 3D scene view (docs/Frontend-Design §9, §23) — engineering visualization,
 * not a game: camera frustum with the actual configured FOV, beacon, live
 * trajectory, subtle grid, XYZ indicator. Updates via direct ref mutation
 * on engine frame events (no React state churn).
 */
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { engine } from '@/lib/engine-client';
import { useFsoc } from '@/lib/store';

const DIST = 24; // distance from camera origin to the target plane (world units)

function scenePxToWorld(
  px: number,
  py: number,
  camPan: number,
  camTilt: number,
  pxPerDeg: number,
): [number, number, number] {
  // angular offsets from boresight (degrees)
  const angX = (px - camPan * pxPerDeg) / pxPerDeg;
  const angY = (py - camTilt * pxPerDeg) / pxPerDeg;
  const x = Math.tan((angX * Math.PI) / 180) * DIST;
  const y = Math.tan((angY * Math.PI) / 180) * DIST;
  return [x, y, -DIST];
}

function BeaconRig({ pxPerDeg }: { pxPerDeg: number }) {
  const beaconRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const frustumRef = useRef<THREE.Group>(null);
  const trajLineRef = useRef<THREE.BufferGeometry>(null);
  const trail = useMemo(() => new Float32Array(900 * 3), []);
  const trailCount = useRef(0);

  useEffect(() => {
    const unsub = engine.onFrame(() => {
      const snap = engine.latest;
      if (!snap || !snap.groundTruth) return;
      const cam = snap.camera;
      const [x, y, z] = scenePxToWorld(
        snap.groundTruth.x_px,
        snap.groundTruth.y_px,
        cam.pan_deg,
        cam.tilt_deg,
        pxPerDeg,
      );
      if (beaconRef.current) beaconRef.current.position.set(x, y, z);
      if (haloRef.current) haloRef.current.position.set(x, y, z);

      // trail
      const idx = (trailCount.current % 900) * 3;
      trail[idx] = x;
      trail[idx + 1] = y;
      trail[idx + 2] = z;
      trailCount.current++;
      const count = Math.min(trailCount.current, 900);
      if (trajLineRef.current) {
        // rebuild ordered positions from ring buffer
        const ordered = new Float32Array(count * 3);
        const start = Math.max(0, trailCount.current - count);
        for (let i = 0; i < count; i++) {
          const srcIdx = ((start + i) % 900) * 3;
          ordered[i * 3] = trail[srcIdx];
          ordered[i * 3 + 1] = trail[srcIdx + 1];
          ordered[i * 3 + 2] = trail[srcIdx + 2];
        }
        trajLineRef.current.setAttribute('position', new THREE.BufferAttribute(ordered, 3));
        trajLineRef.current.setDrawRange(0, count);
      }
    });
    return unsub;
  }, [pxPerDeg, trail]);

  const config = useFsoc((s) => s.config);

  useFrame(() => {
    // frustum follows live camera pose
    const snap = engine.latest;
    if (!frustumRef.current || !snap) return;
    frustumRef.current.rotation.y = -snap.camera.pan_deg * (Math.PI / 180);
    frustumRef.current.rotation.x = snap.camera.tilt_deg * (Math.PI / 180);
  });

  const fovX = (config.camera.fovXDeg * Math.PI) / 180;
  const fovY = (config.camera.fovYDeg * Math.PI) / 180;
  const halfW = Math.tan(fovX / 2) * DIST;
  const halfH = Math.tan(fovY / 2) * DIST;

  return (
    <group>
      {/* beacon */}
      <mesh ref={beaconRef}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial color="#fff7d8" />
      </mesh>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.2, 12, 12]} />
        <meshBasicMaterial color="#fff7d8" transparent opacity={0.16} depthWrite={false} />
      </mesh>

      {/* trajectory line */}
      <line>
        <bufferGeometry ref={trajLineRef}>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(3), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#90a7ff" transparent opacity={0.5} />
      </line>

      {/* camera frustum (rotates with live pan/tilt) — filled transparent pyramid */}
      <group ref={frustumRef}>
        <mesh>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[
                new Float32Array([
                  0, 0, 0, -halfW, -halfH, -DIST, halfW, -halfH, -DIST, // bottom face
                  0, 0, 0, halfW, -halfH, -DIST, halfW, halfH, -DIST,   // right face
                  0, 0, 0, halfW, halfH, -DIST, -halfW, halfH, -DIST,   // top face
                  0, 0, 0, -halfW, halfH, -DIST, -halfW, -halfH, -DIST, // left face
                ]),
                3,
              ]}
            />
          </bufferGeometry>
          <meshBasicMaterial color="#72d9e8" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      </group>

      {/* FOV end-plane rectangle (static, forward direction) */}
      <group>
        <lineLoop position={[0, 0, -DIST]}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[
                new Float32Array([
                  -halfW, -halfH, 0,
                  halfW, -halfH, 0,
                  halfW, halfH, 0,
                  -halfW, halfH, 0,
                ]),
                3,
              ]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#72d9e8" transparent opacity={0.35} />
        </lineLoop>
        {/* frustum edge lines from origin to corners */}
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[
                new Float32Array([
                  0, 0, 0, -halfW, -halfH, -DIST,
                  0, 0, 0, halfW, -halfH, -DIST,
                  0, 0, 0, halfW, halfH, -DIST,
                  0, 0, 0, -halfW, halfH, -DIST,
                ]),
                3,
              ]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#72d9e8" transparent opacity={0.28} />
        </lineSegments>
      </group>

      {/* optical axis */}
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0, 0, 0, -DIST]), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#72d9e8" transparent opacity={0.2} />
      </line>
    </group>
  );
}

export function Scene3D() {
  const config = useFsoc((s) => s.config);

  return (
    <div className="h-full w-full border border-fsoc-border1 rounded-lg overflow-hidden bg-fsoc-bg0 relative" data-testid="scene-3d">
      <Canvas camera={{ position: [10, 7, 14], fov: 50 }} dpr={[1, 1.5]}>
        <color attach="background" args={['#0a0d10']} />
        <ambientLight intensity={0.4} />
        <Grid
          args={[40, 40]}
          cellSize={1}
          cellColor="#1b222a"
          sectionSize={5}
          sectionColor="#263038"
          fadeDistance={45}
          fadeStrength={1.2}
          position={[0, -6, 0]}
          infiniteGrid
        />
        <BeaconRig pxPerDeg={config.camera.resolutionWidth / config.camera.fovXDeg} />
        <axesHelper args={[1.6]} />
        <OrbitControls
          enablePan={false}
          minDistance={6}
          maxDistance={50}
          target={[0, 0, -DIST / 2]}
        />
      </Canvas>
      <div className="absolute bottom-2 left-3 text-[10px] text-fsoc-text3 pointer-events-none">
        3D · FOV {config.camera.fovXDeg.toFixed(1)}° × {config.camera.fovYDeg.toFixed(1)}° · drag to orbit
      </div>
      <div className="absolute top-2 right-3 flex flex-col gap-1 text-[9px] text-fsoc-text3 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#fff7d8]" /> BEACON</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-[2px] bg-[#90a7ff]" /> TRAJECTORY</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-[2px] bg-[#72d9e8]" /> FOV / AXIS</span>
      </div>
    </div>
  );
}
