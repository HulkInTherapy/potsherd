import fs from 'node:fs';
const base='https://github.com/HulkInTherapy/potsherd/blob/phase-4-public-release/';
const readme=fs.readFileSync('../../README.md','utf8').replace(/\]\(([^)]+)\)/g,(all,target)=>/^(?:https?:|#)/.test(target)||['LICENSE','NOTICE'].includes(target)?all:']('+base+target+')');
fs.writeFileSync('README.md',readme);
