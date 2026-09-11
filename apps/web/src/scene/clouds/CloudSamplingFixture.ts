import { ShaderPass } from 'postprocessing';
import { Data3DTexture, FloatType, GLSL3, NearestFilter, RawShaderMaterial, RedFormat, Uniform, type WebGLRenderer } from 'three';
import samplingGLSL from './vendor/takram/src/shaders/cloudSampling.glsl?raw';
import type { CloudConformanceResources } from './CloudConformanceResources';
import type { CloudConformanceResult } from './CloudConformanceFixture';

/** Actual sampling helpers, with a thin near-cloud oracle over a long grazing ray. */
export async function runCloudSamplingConformance(renderer: WebGLRenderer, resources: CloudConformanceResources): Promise<CloudConformanceResult[]> {
  const texels = Float32Array.from({ length: 4 * 4 * 64 }, (_, index) => index);
  const noise = new Data3DTexture(texels, 4, 4, 64);
  noise.format = RedFormat; noise.type = FloatType;
  noise.minFilter = noise.magFilter = NearestFilter; noise.needsUpdate = true;
  const mode = new Uniform(0);
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { stbnTexture: new Uniform(noise), mode },
    vertexShader: 'precision highp float; in vec3 position; void main(){ gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: `precision highp float; precision highp sampler3D;
      uniform sampler3D stbnTexture; uniform int mode;
      ${samplingGLSL}
      layout(location=0) out vec4 value; layout(location=1) out vec4 metadata;
      float integrateRay(float jitter, bool legacy, out float endpoint) {
        const float span=400000.0;
        float distance=0.0, stepSize=80.0, tau=0.0;
        for(int i=0;i<192;++i) {
          float remaining=span-distance, count=float(192-i);
          float budget=legacy?remaining/count:cloudBudgetStep(remaining,count,1.04);
          float lengthM=min(remaining,max(clamp(stepSize,80.0,800.0),budget));
          float position=distance+lengthM*jitter;
          // Gaussian density centred 2 km away, integral = 450*sqrt(pi).
          tau+=0.001*exp(-pow((position-2000.0)/450.0,2.0))*lengthM;
          distance+=lengthM; stepSize=min(800.0,stepSize*1.04);
        }
        endpoint=distance;
        return 1.0-exp(-tau);
      }
      void main(){
        metadata=vec4(0.0);
        if(mode==0){
          uint lo=0u,hi=0u,oldLo=0u,oldHi=0u;
          for(int i=0;i<64;++i){
            int layer=int(samplePrimarySTBN(vec2(0.5),i*16))/16;
            int oldLayer=(i*16)%64;
            if(layer<32)lo|=1u<<uint(layer); else hi|=1u<<uint(layer-32);
            if(oldLayer<32)oldLo|=1u<<uint(oldLayer); else oldHi|=1u<<uint(oldLayer-32);
          }
          float count=0.0,oldCount=0.0;
          for(int i=0;i<32;++i){uint bit=1u<<uint(i);
            count+=float((lo&bit)!=0u)+float((hi&bit)!=0u);
            oldCount+=float((oldLo&bit)!=0u)+float((oldHi&bit)!=0u);
          }
          value=vec4(count,oldCount,samplePrimarySTBN(vec2(1.5,2.5),16),samplePrimarySTBN(vec2(4.5,6.5),1024));
        } else if(mode==1){
          float exact=1.0-exp(-0.001*450.0*sqrt(3.141592653589793));
          float squared=0.0,oldSquared=0.0,endpoint=0.0;
          for(int i=0;i<64;++i){
            float jitter=(float(i)+0.5)/64.0;
            float result=integrateRay(jitter,false,endpoint);
            float oldEndpoint;
            float old=integrateRay(jitter,true,oldEndpoint);
            squared+=pow(result-exact,2.0);oldSquared+=pow(old-exact,2.0);
          }
          value=vec4(sqrt(squared/64.0),sqrt(oldSquared/64.0),endpoint/400000.0,exact);
        } else {
          value=vec4(cloudBudgetStep(400000.0,192.0,1.0),cloudBudgetStep(400000.0,192.0,1.04),
            cloudBudgetStep(1000.0,1.0,1.04),cloudBudgetStep(1000.0,5.0,0.9));
        }
      }`,
  });
  const pass = new ShaderPass(material);
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], tolerance: number) => {
    const maxError = measured.every(Number.isFinite) ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]))) : Infinity;
    cases.push({ name, measured, expected, maxError, passed: maxError <= tolerance });
  };
  const draw = async (index: number) => { mode.value = index; resources.draw(() => pass.render(renderer, null, resources.output)); return resources.readCenter(); };
  try {
    const noiseResult = await draw(0);
    record('sampling-full-noise-cycle-and-spatial-address-with-legacy-control', noiseResult, [64, 4, 25, 8], 1e-4);
    const integration = await draw(1);
    record('sampling-thin-near-cloud-opacity-rms', [integration[0]], [0], 0.02);
    record('sampling-old-uniform-budget-reproduces-noise', [Number(integration[1] > 0.1)], [1], 0);
    record('sampling-complete-grazing-ray', [integration[2]], [1], 1e-5);
    const budget = await draw(2);
    record('sampling-uniform-limit-and-final-segment', [budget[0], budget[2], budget[3]], [400000 / 192, 1000, 200], 0.02);
    record('sampling-near-step-below-uniform-budget', [Number(budget[1] > 0 && budget[1] < budget[0] / 5)], [1], 0);
    return cases;
  } finally { pass.dispose(); material.dispose(); noise.dispose(); }
}
