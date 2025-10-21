// --- VALIDATION METADATA ---
const VALIDATIONS = [
  { key:'exists', title:'Verificar existencia de tabla', category:'Estructura y Metadatos', desc:'Verifica que la tabla exista dentro del dataset.', purpose:'Evitar errores posteriores por tablas faltantes.', criteria:["Tabla presente en INFORMATION_SCHEMA"], sqlTemplate: (p,d,t)=>`SELECT table_name FROM \`${p}.${d}\`.INFORMATION_SCHEMA.TABLES WHERE table_name='${t}';` },
  { key:'headers', title:'Validar cabeceras de columna', category:'Estructura y Metadatos', desc:'Compara las cabeceras reales con las esperadas (orden y nombres).', purpose:'Asegurar formato y orden de columnas en reportes/ingestas.', criteria:['Igualdad en número y nombre de columnas','Mismo orden'], sqlTemplate:(p,d,t,expected)=>{
      const exp = (expected||'').split(',').map(s=>`'${s.trim()}'`).join(', ');
      return `WITH cols AS (SELECT ARRAY_AGG(column_name ORDER BY ordinal_position) cols FROM \`${p}.${d}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name='${t}')\nSELECT IF(TO_JSON_STRING(cols)=TO_JSON_STRING([${exp}]), 'OK','MISMATCH') AS resultado, cols FROM cols;`;
  }},
  { key:'types', title:'Verificar tipos de datos', category:'Estructura y Metadatos', desc:'Valida que los tipos de columnas coincidan con los esperados.', purpose:'Garantizar compatibilidad de tipos entre procesos.', criteria:['Comparar data_type en INFORMATION_SCHEMA','Reportar discrepancias'], sqlTemplate:(p,d,t)=>`SELECT column_name, data_type FROM \`${p}.${d}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name='${t}' ORDER BY ordinal_position;` },

  { key:'count', title:'Conteo total de registros', category:'Integridad de Datos', desc:'Cuenta registros en fuente y destino para comparar.', purpose:'Detectar pérdidas o duplicados globales.', criteria:['Conteo por tabla'], sqlTemplate:(p,d,src,dest,filter)=> {
      const f = filter?`WHERE ${filter}`:'';
      let q = `SELECT '${src}' AS tabla, COUNT(*) AS total FROM \`${p}.${d}.${src}\` ${f}`;
      if(dest) q += `\nUNION ALL\nSELECT '${dest}' AS tabla, COUNT(*) AS total FROM \`${p}.${d}.${dest}\``;
      return q; }
  },

  { key:'nulls', title:'Verificar valores nulos', category:'Integridad de Datos', desc:'Cuenta valores NULL por campo.', purpose:'Medir calidad y completitud por campo.', criteria:['COUNT(*) WHERE field IS NULL'], sqlTemplate:(p,d,t,fields,filter)=>{
      const flds = (fields||[]).map(f=>`SELECT '${f}' AS campo, COUNT(*) AS null_count FROM \`${p}.${d}.${t}\` WHERE ${f} IS NULL${filter?` AND ${filter}`:''};`).join('\n\n');
      return flds || `-- No se especificaron campos para nulidad.`;
  }},

  { key:'duplicates', title:'Detectar duplicados', category:'Integridad de Datos', desc:'Encuentra valores duplicados en los campos indicados.', purpose:'Evitar inconsistencias por duplicidad de llaves o identificadores.', criteria:['GROUP BY + HAVING COUNT>1'], sqlTemplate:(p,d,t,fields,filter)=>{
      return (fields||[]).map(f=>`SELECT ${f} AS valor, COUNT(*) AS cnt FROM \`${p}.${d}.${t}\` ${filter?`WHERE ${filter}`:''} GROUP BY ${f} HAVING COUNT(*)>1;`).join('\n\n') || `-- No se especificaron campos para detectar duplicados.`;
  }},

  { key:'diff', title:'Verificar valores diferentes', category:'Integridad de Datos', desc:'Compara campo a campo entre fuente y destino para detectar diferencias.', purpose:'Asegurar que la carga/transformación preserve valores.', criteria:['EXCEPT DISTINCT entre conjuntos de campos'], sqlTemplate:(p,d,src,dest,fields,filter)=>{
      const fl = (fields||[]).join(', ') || '*';
      const f = filter?`WHERE ${filter}`:'';
      return `-- En fuente pero no en destino\nSELECT ${fl} FROM \`${p}.${d}.${src}\` ${f}\nEXCEPT DISTINCT\nSELECT ${fl} FROM \`${p}.${d}.${dest}\`;\n\n-- En destino pero no en fuente\nSELECT ${fl} FROM \`${p}.${d}.${dest}\`\nEXCEPT DISTINCT\nSELECT ${fl} FROM \`${p}.${d}.${src}\` ${f};`;
  }},

  { key:'uniqueness', title:'Unicidad (campos seleccionados)', category:'Otras Validaciones Avanzadas', desc:'Verifica que los campos definidos como únicos no tengan duplicados.', purpose:'Integridad de identificadores y llaves primarias.', criteria:['GROUP BY campo HAVING COUNT>1'], sqlTemplate:(p,d,t,fields,filter)=>{
      return (fields||[]).map(f=>`SELECT ${f}, COUNT(*) cnt FROM \`${p}.${d}.${t}\` ${filter?`WHERE ${filter}`:''} GROUP BY ${f} HAVING COUNT(*)>1;`).join('\n\n') || `-- No se especificaron campos para unicidad.`;
  }},

  { key:'recon', title:'Reconciliación Numérica', category:'Otras Validaciones Avanzadas', desc:'Compara sumas agregadas por clave entre fuente y destino.', purpose:'Detectar diferencias numéricas por agrupación.', criteria:['SUM por agrupación y FULL JOIN'], sqlTemplate:(p,d,src,dest,keyField,numericField,filter)=>{
      if(!keyField||!numericField) return `-- Reconciliación requiere campo clave y campo numérico.`;
      const f = filter?`WHERE ${filter}`:'';
      return `WITH src AS (SELECT ${keyField}, SUM(${numericField}) AS total FROM \`${p}.${d}.${src}\` ${f} GROUP BY ${keyField}),\n     dest AS (SELECT ${keyField}, SUM(${numericField}) AS total FROM \`${p}.${d}.${dest}\` GROUP BY ${keyField})\nSELECT s.${keyField}, s.total AS total_src, d.total AS total_dest, (s.total - d.total) AS diferencia\nFROM src s FULL JOIN dest d USING(${keyField})\nWHERE COALESCE(s.total,0) != COALESCE(d.total,0);`;
  }},

  { key:'tol', title:'Tolerancia (%)', category:'Otras Validaciones Avanzadas', desc:'Retorna filas donde la diferencia porcentual supera un umbral.', purpose:'Permitir variaciones aceptables en reconciliación.', criteria:['SAFE_DIVIDE(|src-dest|,dest)*100 > tol'], sqlTemplate:(p,d,src,dest,keyField,numericField,tol,filter)=>{
      if(!keyField||!numericField) return `-- Tolerancia requiere campo clave y campo numérico.`;
      const f = filter?`AND ${filter}`:'';
      return `WITH comp AS (\n  SELECT s.${keyField} AS key_val, s.${numericField} AS src_val, d.${numericField} AS dest_val, SAFE_DIVIDE(ABS(s.${numericField}-d.${numericField}), NULLIF(d.${numericField},0))*100 AS diff_pct\n  FROM \`${p}.${d}.${src}\` s\n  JOIN \`${p}.${d}.${dest}\` d USING(${keyField})\n  WHERE TRUE ${f}\n)\nSELECT * FROM comp WHERE diff_pct > ${tol};`;
  }},
];

// --- UI: populate drawer ---
const validationListEl = document.getElementById('validationList');
function renderValidationList(filterText=''){
  validationListEl.innerHTML='';
  const txt = filterText.trim().toLowerCase();
  VALIDATIONS.forEach(v=>{
    if(txt && !(v.title.toLowerCase().includes(txt) || (v.desc||'').toLowerCase().includes(txt) )) return;
    const item = document.createElement('div');
    item.className='list-group-item';
    item.innerHTML = `<div class="d-flex justify-content-between align-items-start">
        <div>
          <div class="fw-semibold">${v.title}</div>
          <div class="small text-muted">${v.category} — ${v.desc}</div>
        </div>
        <div class="text-end">
          <button class="btn btn-sm btn-primary me-1" data-action="insert" data-key="${v.key}">Insertar</button>
          <button class="btn btn-sm btn-outline-secondary" data-action="preview" data-key="${v.key}">Ver SQL</button>
        </div>
      </div>`;
    validationListEl.appendChild(item);
  });
}
renderValidationList();

// Drawer open/close
const drawer = document.getElementById('drawer');
const openDrawerBtn = document.getElementById('openDrawerBtn');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');
openDrawerBtn.addEventListener('click', ()=> drawer.classList.add('open'));
closeDrawerBtn.addEventListener('click', ()=> drawer.classList.remove('open'));

// Search in drawer
document.getElementById('searchValidation').addEventListener('input', (e)=> renderValidationList(e.target.value));

// Drawer buttons: insert or preview
validationListEl.addEventListener('click', (e)=>{
  const btn = e.target.closest('button'); if(!btn) return;
  const action = btn.dataset.action; const key = btn.dataset.key;
  const v = VALIDATIONS.find(x=>x.key===key); if(!v) return;
  if(action==='insert'){
    // find checkbox and check it
    const chk = document.querySelector(`input.form-check-input[data-key='${key}']`);
    if(chk){ chk.checked = true; chk.scrollIntoView({behavior:'smooth', block:'center'}); }
  } else if(action==='preview'){
    // build SQL preview using current form values
    const sql = buildSQLForValidation(v.key);
    const prev = `-- SQL (previsualización) para: ${v.title}\n\n${sql}`;
    document.getElementById('sqlArea').textContent = prev;
    drawer.classList.add('open');
  }
});

// Helper: get form values
function getFormValues(){
  return {
    project: document.getElementById('project').value.trim(),
    dataset: document.getElementById('dataset').value.trim(),
    src: document.getElementById('tableSource').value.trim(),
    dest: document.getElementById('tableDest').value.trim(),
    fields: document.getElementById('fields').value.split(',').map(s=>s.trim()).filter(Boolean),
    filter: document.getElementById('filter').value.trim(),
    expectedHeader: document.getElementById('expectedHeader').value.trim(),
    keyField: document.getElementById('keyField').value.trim(),
    numericField: document.getElementById('numericField').value.trim(),
    tolerance: document.getElementById('tolerance').value.trim() || 0,
  };
}

// Build SQL per validation
function buildSQLForValidation(key){
  const f = getFormValues();
  const v = VALIDATIONS.find(x=>x.key===key);
  if(!v) return `-- Validación no encontrada: ${key}`;
  try{
    switch(key){
      case 'exists': return v.sqlTemplate(f.project,f.dataset,f.src);
      case 'headers': return v.sqlTemplate(f.project,f.dataset,f.src,f.expectedHeader);
      case 'types': return v.sqlTemplate(f.project,f.dataset,f.src);
      case 'count': return v.sqlTemplate(f.project,f.dataset,f.src,f.dest,f.filter);
      case 'nulls': return v.sqlTemplate(f.project,f.dataset,f.src,f.fields,f.filter);
      case 'duplicates': return v.sqlTemplate(f.project,f.dataset,f.src,f.fields,f.filter);
      case 'diff': return v.sqlTemplate(f.project,f.dataset,f.src,f.dest,f.fields,f.filter);
      case 'uniqueness': return v.sqlTemplate(f.project,f.dataset,f.src,f.fields,f.filter);
      case 'recon': return v.sqlTemplate(f.project,f.dataset,f.src,f.dest,f.keyField,f.numericField,f.filter);
      case 'tol': return v.sqlTemplate(f.project,f.dataset,f.src,f.dest,f.keyField,f.numericField,f.tolerance,f.filter);
      default: return `-- Plantilla no implementada para: ${key}`;
    }
  }catch(err){return `-- Error generando SQL: ${err.message}`;}
}

// Generate overall SQL based on checked validations
function generateSQL(){
  const project = document.getElementById('project').value.trim();
  const dataset = document.getElementById('dataset').value.trim();
  const src = document.getElementById('tableSource').value.trim();
  if(!project||!dataset||!src){ alert('Proyecto, dataset y tabla fuente son obligatorios.'); return; }

  const checked = Array.from(document.querySelectorAll('input.form-check-input:checked')).map(ch=>ch.dataset.key);
  if(checked.length===0){ document.getElementById('sqlArea').textContent='-- Ninguna validación seleccionada.'; return; }

  const header = `-- Validaciones generadas\n-- Proyecto: ${project}\n-- Dataset: ${dataset}\n-- Tabla fuente: ${src}\n-- Fecha: ${new Date().toISOString()}\n\n`;
  const sections = [];
  checked.forEach(k=>{
    const sql = buildSQLForValidation(k);
    const v = VALIDATIONS.find(x=>x.key===k);
    if(sql){
      sections.push(`-- === ${v.title} ===\n-- ${v.desc}\n${sql}\n`);
    }
  });
  document.getElementById('sqlArea').textContent = header + sections.join('\n');
}

// Copy / Download
function copySQL(){ navigator.clipboard.writeText(document.getElementById('sqlArea').textContent).then(()=>alert('SQL copiado al portapapeles.')) }
function downloadSQLFile(){ const blob=new Blob([document.getElementById('sqlArea').textContent],{type:'text/sql'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='validaciones.sql'; a.click(); URL.revokeObjectURL(url); }

// Export CSV / TXT (with audit header)
function gatherExportRows(){
  const form = getFormValues();
  const checked = Array.from(document.querySelectorAll('input.form-check-input:checked')).map(ch=>ch.dataset.key);
  const rows = [];
  const ts = new Date().toISOString();
  checked.forEach(k=>{
    const v = VALIDATIONS.find(x=>x.key===k);
    const sql = buildSQLForValidation(k);
    rows.push({validation:v.title, category:v.category, description:v.desc, sql:sql, project:form.project, dataset:form.dataset, table:form.src, generated:ts});
  });
  return rows;
}

function exportCSV(){
  const rows = gatherExportRows();
  if(rows.length===0){ alert('No hay validaciones seleccionadas para exportar.'); return; }
  const headers = ['Tipo de Validación','Categoría','Descripción','SQL Generado','Proyecto','Dataset','Tabla Fuente','FechaGeneracion'];
  const lines = [headers.join(',')];
  rows.forEach(r=>{
    // escape double quotes
    const esc = v=>`"${(v||'').toString().replace(/"/g,'""')}"`;
    lines.push([esc(r.validation),esc(r.category),esc(r.description),esc(r.sql),esc(r.project),esc(r.dataset),esc(r.table),esc(r.generated)].join(','));
  });
  const blob = new Blob([lines.join('\n')],{type:'text/csv'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='validaciones_export.csv'; a.click(); URL.revokeObjectURL(url);
}

function exportTXT(){
  const rows = gatherExportRows();
  if(rows.length===0){ alert('No hay validaciones seleccionadas para exportar.'); return; }
  const parts = [];
  rows.forEach(r=>{
    parts.push(`=== ${r.validation} (${r.category}) ===\nDescripcion: ${r.description}\nProyecto: ${r.project}\nDataset: ${r.dataset}\nTabla: ${r.table}\nGenerado: ${r.generated}\nSQL:\n${r.sql}\n\n`);
  });
  const blob = new Blob([parts.join('\n')],{type:'text/plain'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='validaciones_export.txt'; a.click(); URL.revokeObjectURL(url);
}

function clearOutput(){ document.getElementById('sqlArea').textContent='-- Aquí aparecerán los SQL generados'; }

// Initial: check items that were default-checked
renderValidationList();