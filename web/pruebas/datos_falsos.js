(() => {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const iso = (d) => d.toISOString();
  const emisores = [
    "CONSULTORIO MEDICO DR. ALEJANDRO RUIZ HERNANDEZ Y ASOCIADOS SC",
    "COLEGIO MEXICO NUEVO AC", "SEGUROS MONTERREY NEW YORK LIFE SA DE CV",
    "BBVA MEXICO SA INSTITUCION DE BANCA MULTIPLE", "TRANSPAIS UNICO",
    "GASOLINERA LAS PALMAS", "ARQUITECTURA Y DESARROLLO URBANO ADEURSA",
    "FARMACIAS BENAVIDES SAB DE CV",
  ];
  const cats = ["Médicos","Colegiaturas","Seguros GMM","Hipoteca","Servicios","Arrendamiento","Sin clasificar"];
  const ests = ["valida","valida","valida","advertencia","por_revisar","rechazada","archivada"];
  const facturas = [];
  for (let i = 0; i < 24; i++) {
    facturas.push({
      id: i + 1,
      uuid: "A4F29C1D-1234-4ABC-9C1D-" + String(100000000000 + i),
      emisor_rfc: "RUAA791102H1A", emisor_nombre: emisores[i % emisores.length],
      receptor_rfc: i % 5 === 0 ? "XAXX010101000" : "AUCD870504PU0",
      fecha_emision: anio + "-" + String((i % 12) + 1).padStart(2,"0") + "-1" + (i % 9),
      anio: anio, subtotal: 1000 + i * 137, iva: 160, total: 1160 + i * 159,
      uso_cfdi: "D02", forma_pago: "03", metodo_pago: "PUE",
      clave_prod_principal: "629298", concepto_descripcion: "Consulta",
      categoria: cats[i % cats.length], confianza: 0.95,
      estatus: ests[i % ests.length],
      hallazgos: i % 6 === 3
        ? [{codigo:"RFC_AJENO",severidad:"advertencia",mensaje:"Factura emitida a RFC XAXX010101000; no será deducible"}]
        : [],
      tiene_pdf: i % 2 === 0, usuario_rfc: "AUCD870504PU0",
      created_at: iso(new Date(hoy - i * 86400000)),
    });
  }
  const categorias = {};
  facturas.forEach(f => {
    const c = categorias[f.categoria] || {total:0, facturas:0};
    c.total += f.total; c.facturas += 1; categorias[f.categoria] = c;
  });

  const RUTAS = {
    "api-user-profile": {id:17, email:"danzt@hotmail.com", nombre:"Daniel Azuara",
      rfc:"AUCD870504PU0", plan:"free", web_token:"TOKEN", whatsapp_phone:"5218186811851", rol:"admin"},
    "api-user-rfcs": {rfcs:[
      {id:1, rfc:"AUCD870504PU0", tipo:"fisica", alias:"Principal", es_principal:true},
      {id:2, rfc:"DJB850527F30", tipo:"moral", alias:"Distribuidora Arca Continental", es_principal:false}]},
    "api-user-authorized-senders": {correos:[
      {id:1, email:"contacto@golfdynasty.mx", alias:"Golf"},
      {id:2, email:"daniel.aztudillo@arcacontal.com", alias:"Trabajo"},
      {id:3, email:"lau_ponce@hotmail.com", alias:"Laura"}]},
    "api-invoices": {year:anio, invoices:facturas},
    "api-summary": {year:anio, categorias:categorias,
      total_general:facturas.reduce((a,f)=>a+f.total,0), num_facturas:facturas.length},
    "api-admin-metrics": {cuentas:{total:143, activas:139, suspendidas:4, nuevas_7d:12,
      nuevas_30d:38, sin_password:47, rfc_pendiente:31, con_facturas:96, sin_facturas:47},
      facturas:{total:1284, ultimos_30d:212, monto_total:2481930.55,
        por_estatus:{valida:900, advertencia:210, por_revisar:98, rechazada:41, archivada:35},
        por_canal:{correo:604, whatsapp:412, web:151, desconocido:117}}},
  };
  const cuentas = [];
  for (let i = 0; i < 18; i++) {
    cuentas.push({id:100+i,
      email: i%4===0 ? "wa-52181868118"+i+"@facturapp.mx" : "usuario.prueba"+i+"@gmail.com",
      nombre: i%4===0 ? "5218186811851" : ["Daniel Azuara","María Fernanda González","Luis Ponce","Ana Sofía Martínez del Río"][i%4],
      rfc: i%3===0 ? "PEND41EAF8FF9" : "AUCD8705040"+(i%10)+"0",
      plan:"free", rol: i===0?"admin":"usuario", whatsapp_phone: i%2?null:"5218186811851",
      created_at: iso(new Date(hoy - i*86400000*3)),
      suspendida_en: i%7===5 ? iso(new Date(hoy - 86400000)) : null,
      suspendida_motivo: i%7===5 ? "spam" : null,
      tiene_password: i%4!==0, rfc_pendiente: i%3===0,
      num_facturas: (i*7)%40, ultima_factura_en: i%5===4 ? null : iso(new Date(hoy - i*86400000)),
    });
  }
  RUTAS["api-admin-users"] = {cuentas:cuentas, total:cuentas.length};
  const DETALLE = {cuenta:cuentas[2], rfcs:RUTAS["api-user-rfcs"].rfcs,
    correos:RUTAS["api-user-authorized-senders"].correos,
    facturas:facturas.slice(0,6).map(f=>({...f, origen:["correo","whatsapp","web",null][f.id%4]}))};

  window.fetch = function (url) {
    const u = String(url);
    if (u.includes("api-admin-users") && u.includes("id=")) {
      return Promise.resolve(new Response(JSON.stringify(DETALLE), {status:200}));
    }
    for (const k in RUTAS) {
      if (u.includes(k)) return Promise.resolve(new Response(JSON.stringify(RUTAS[k]), {status:200}));
    }
    return Promise.resolve(new Response("{}", {status:200}));
  };
  sessionStorage.setItem("facturapp_token", "token-de-prueba");
})();
