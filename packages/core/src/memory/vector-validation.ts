import {blobToEmbedding} from '../embeddings.js';
export const SPAN_VECTOR_DIMENSIONS=384;
/** The pinned representation is L2 normalized. Allow Float32 rounding, not
 * zero/unnormalized/nonfinite payloads. This is structural validation, not a
 * checksum or proof against every possible storage corruption.
 */
export function validSpanVector(vector:readonly number[]|Float32Array):boolean {
 if(vector.length!==SPAN_VECTOR_DIMENSIONS)return false;
 let squaredNorm=0;
 for(let i=0;i<vector.length;i++){const value=vector[i];if(value===undefined||!Number.isFinite(value))return false;squaredNorm+=value*value;}
 return Number.isFinite(squaredNorm)&&Math.abs(squaredNorm-1)<=0.002;
}
export function validatedSpanVectorBlob(blob:Buffer|Uint8Array|null|undefined):Float32Array|null {
 if(!blob||blob.byteLength!==SPAN_VECTOR_DIMENSIONS*4)return null;
 const vector=blobToEmbedding(blob);return validSpanVector(vector)?vector:null;
}
