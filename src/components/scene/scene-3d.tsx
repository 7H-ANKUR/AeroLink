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

  // §29: the receiver terminal, its boresight ray and the TX→RX line of sight
  const panYokeRef = useRef<THREE.Group>(null);
  const tiltHeadRef = useRef<THREE.Group>(null);
  const losRef = useRef<THREE.BufferGeometry>(null);

  useFrame(() => {
    const snap = engine.latest;
    if (!snap) return;

    // Mount orientation comes from the engine's mount telemetry — the pan yoke
    // and tilt head are driven by the SAME azimuth/elevation the controller
    // produced and the mount dynamics integrated. Nothing here animates on its
    // own: with the controller disabled these stay still.
    const azRad = -snap.mount.azimuthDeg * (Math.PI / 180);
    const elRad = snap.mount.elevationDeg * (Math.PI / 180);
    if (panYokeRef.current) panYokeRef.current.rotation.y = azRad;
    if (tiltHeadRef.current) tiltHeadRef.current.rotation.x = elRad;
    if (frustumRef.current) {
      frustumRef.current.rotation.y = azRad;
      frustumRef.current.rotation.x = elRad;
    }

    // Optical line of sight: receiver origin → the beacon's actual position.
    // As the mount converges, the boresight ray (drawn inside the yoke) and
    // this line visibly close on each other.
    if (losRef.current && beaconRef.current) {
      const b = beaconRef.current.position;
      const pts = new Float32Array([0, 0, 0, b.x, b.y, b.z]);
      losRef.current.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      losRef.current.setDrawRange(0, 2);
    }
  });

  const fovX = (config.camera.fovXDeg * Math.PI) / 180;
  const fovY = (config.camera.fovYDeg * Math.PI) / 180;
  const halfW = Math.tan(fovX / 2) * DIST;
  const halfH = Math.tan(fovY / 2) * DIST;

  return (
    <group>
      {/* beacon (TX source marker) */}
      <mesh ref={beaconRef}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial color="#e8891f" />
      </mesh>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.2, 12, 12]} />
        <meshBasicMaterial color="#e8891f" transparent opacity={0.16} depthWrite={false} />
      </mesh>

      {/* trajectory line */}
      <line>
        <bufferGeometry ref={trajLineRef}>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(3), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#3d6bb8" transparent opacity={0.5} />
      </line>

      {/* ── simulated optical line of sight, TX → RX ── */}
      <line>
        <bufferGeometry ref={losRef}>
          <bufferAttribute attach="attributes-position" args={[new Float32Array(6), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#e8891f" transparent opacity={0.55} />
      </line>

      {/* ── RX terminal: base, pan yoke, tilt head, boresight ray ── */}
      <group>
        {/* fixed base */}
        <mesh position={[0, -0.34, 0]}>
          <cylinderGeometry args={[0.3, 0.38, 0.12, 20]} />
          <meshBasicMaterial color="#8d8478" />
        </mesh>
        {/* pan yoke — rotates in azimuth with the mount */}
        <group ref={panYokeRef}>
          <mesh position={[0, -0.18, 0]}>
            <cylinderGeometry args={[0.16, 0.2, 0.22, 16]} />
            <meshBasicMaterial color="#b5a897" />
          </mesh>
          {/* tilt head — rotates in elevation with the mount */}
          <group ref={tiltHeadRef}>
            <mesh>
              <boxGeometry args={[0.34, 0.24, 0.3]} />
              <meshBasicMaterial color="#d7c9b4" />
            </mesh>
            {/* objective */}
            <mesh position={[0, 0, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.1, 0.1, 0.16, 16]} />
              <meshBasicMaterial color="#3c3a36" />
            </mesh>
            {/* boresight ray — where the receiver is actually looking */}
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[new Float32Array([0, 0, -0.26, 0, 0, -DIST * 1.15]), 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#ce4710" transparent opacity={0.9} />
            </line>
          </group>
        </group>
      </group>

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
          <meshBasicMaterial color="#ce4710" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
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
          <lineBasicMaterial color="#ce4710" transparent opacity={0.35} />
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
          <lineBasicMaterial color="#ce4710" transparent opacity={0.28} />
        </lineSegments>
      </group>

      {/* optical axis */}
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0, 0, 0, -DIST]), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#ce4710" transparent opacity={0.2} />
      </line>
    </group>
  );
}

export function Scene3D() {
  const config = useFsoc((s) => s.config);

  return (
    <div className="h-full w-full border border-fsoc-border1 rounded-lg overflow-hidden bg-fsoc-bg0 relative" data-testid="scene-3d">
      <Canvas camera={{ position: [10, 7, 14], fov: 50 }} dpr={[1, 1.5]}>
        <color attach="background" args={['#f3ece4']} />
        <ambientLight intensity={0.4} />
        <Grid
          args={[40, 40]}
          cellSize={1}
          cellColor="#e0d4c6"
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
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#e8891f]" /> BEACON</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-[2px] bg-[#3d6bb8]" /> TRAJECTORY</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-[2px] bg-[#ce4710]" /> BORESIGHT / FOV</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-[2px] bg-[#e8891f]" /> OPTICAL LOS</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[#d7c9b4]" /> RX TERMINAL</span>
      </div>
    </div>
  );
}
