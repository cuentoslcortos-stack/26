import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Identifica a la materia y sirve como anclaje en la UI
 * (panel de Configuración muestra este string).
 */
export const ASSISTANT_LABEL =
  "Asistente 26 Ver. 2.2 — Historia Sociocultural del Arte II (Cód. 26, Cátedra Dra. Karina Mauro — Artes Multimediales - UNA)";

/**
 * Base de conocimiento de la materia: PDFs servidos como archivos
 * estáticos en `public/` y subidos a Gemini File API en runtime.
 *
 * El modelo NO debe responder con nada que no esté en estos dos PDFs.
 * Se suben a Gemini File API una sola vez por sesión y se referencian
 * por fileUri (cache 24 h en localStorage).
 */
const VITE_BASE_URL: string =
  ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.BASE_URL ?? "/");

const PDF_SOURCES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "HSCA2_FULL.pdf", path: `${VITE_BASE_URL}HSCA2_FULL.pdf` },
] as const;

/**
 * Cache en localStorage: para cada PDF guardamos { uri, expiry }.
 * TTL: 24h (la File API de Gemini expira a las 48h, dejamos margen).
 */
const KB_CACHE_PREFIX = "gem-pdf-uri:";
const KB_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedUri {
  uri: string;
  expiry: number;
}

function readCachedUri(name: string): string | null {
  try {
    const raw = localStorage.getItem(KB_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUri;
    if (!parsed?.uri || !parsed?.expiry) return null;
    if (parsed.expiry < Date.now()) return null;
    return parsed.uri;
  } catch {
    return null;
  }
}

function writeCachedUri(name: string, uri: string): void {
  try {
    const payload: CachedUri = { uri, expiry: Date.now() + KB_TTL_MS };
    localStorage.setItem(KB_CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* sin persistencia: se re-subirá cada vez */
  }
}

/**
 * Sube un PDF a Gemini File API y devuelve el fileUri.
 * Si ya hay uno cacheado en localStorage (no expirado), lo reusa.
 */
async function ensurePdfUploaded(
  ai: GoogleGenAI,
  name: string,
  path: string
): Promise<string> {
  const cached = readCachedUri(name);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${name} desde el sitio (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`El archivo ${name} está vacío.`);
  }

  const uploaded = await ai.files.upload({
    file: new File([blob], name, { type: "application/pdf" }),
    config: { displayName: name },
  });
  const uri = uploaded?.uri;
  if (!uri) {
    throw new Error(`No se pudo subir ${name} a Gemini File API.`);
  }
  writeCachedUri(name, uri);
  return uri;
}

/**
 * Prepara la base de conocimiento: sube los PDFs declarados en
 * `PDF_SOURCES` a Gemini File API (o reutiliza los URIs cacheados)
 * y devuelve un array de `fileData` listo para meter en `parts[]`.
 *
 * Si `PDF_SOURCES` está vacío, lanza un error claro para que el
 * usuario sepa que falta cargar el material antes de usar la app.
 */
async function buildKnowledgeBaseParts(
  ai: GoogleGenAI,
  onProgress?: (msg: string) => void
): Promise<{ fileData: { fileUri: string; mimeType: string } }[]> {
  if (PDF_SOURCES.length === 0) {
    throw new Error(
      "La base de conocimiento está vacía. Copiá los PDFs a public/ y " +
        "registralos en PDF_SOURCES dentro de src/lib/gemini.ts."
    );
  }
  const parts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  for (const src of PDF_SOURCES) {
    onProgress?.(`Subiendo ${src.name} a Gemini…`);
    const uri = await ensurePdfUploaded(ai, src.name, src.path);
    parts.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  }
  return parts;
}

/**
 * Prompt del sistema — Tutor 26 Ver. 2.2, materia
 * "Historia Sociocultural del Arte II" (Código 26, Cátedra
 * Dra. Karina Mauro — Artes Multimediales, UNA).
 */
export const SYSTEM_PROMPT = `# SYSTEM PROMPT: EXPERTO TUTOR ACADÉMICO
## Historia Sociocultural del Arte II (Cód. 26)
(Cátedra Dra. Karina Mauro - Carrera de Artes Multimediales. Universidad Nacional de las Artes)

### 1. IDENTIDAD Y PROPÓSITO
Eres un Tutor de Inteligencia Artificial especializado de forma exclusiva en la materia "Historia Sociocultural del Arte II" de la Licenciatura en Artes Multimediales de la Universidad Nacional de las Artes (UNA), dictada por la Dra. Karina Mauro. Tu misión es asistir a los estudiantes en la comprensión conceptual profunda de los procesos históricos, socioculturales y artísticos de la Modernidad, la preparación de trabajos prácticos (análisis de la Modernidad, crítica de ópera lírica, y exposición multimedia sobre novela del siglo XIX) y la aprobación de exámenes parciales y finales, reproduciendo con exactitud el rigor teórico, metodológico y crítico de la cátedra.

### 2. FUENTES DE INFORMACIÓN: GUÍA VS. BASE DE CONOCIMIENTOS
Debes diferenciar de forma taxativa la función de los documentos y herramientas de consulta:
- Guía Metodológica y Pedagógica (Programa Oficial y Cronograma de Cátedra): Funciona como brújula de evaluación. Define las unidades temáticas, la organización cronológica clase por clase, los objetivos de aprendizaje, los contenidos mínimos, los trabajos prácticos obligatorios y el modo en que la cátedra exige articular los procesos socioculturales con las prácticas artísticas, los dispositivos de creación (como la ciudad, la imprenta, el teatro o la fotografía) y las producciones multimediales contemporáneas.
- Base de Conocimientos Exclusiva para Textos Teóricos ("HSCA2_FULL.pdf" y Programa): Tienes a tu disposición permanente la base de conocimientos integrada en el documento PDF titulado "HSCA2_FULL.pdf", el cual contiene el resumen integral de todos los textos y autores obligatorios necesarios para la cursada. La totalidad de las citas, marcos conceptuales y desarrollos teóricos de autores (Berman, Burke, Calinescu, Hobsbawm, Romero, Bajtín, Todorov, Nochlin, Wölfflin, Shiner, etc.) debe extraerse y consultarse ÚNICA Y EXCLUSIVAMENTE de este archivo "HSCA2_FULL.pdf" y de los materiales teóricos pautados por la Dra. Karina Mauro.
- Tratamiento de Materiales Audiovisuales y Filmografía: Dado que no cuentas con los guiones literarios de las películas y videos obligatorios de la cátedra (tales como El Decamerón de Pasolini, El nombre de la rosa de Annaud, La Misión, Aguirre la ira de Dios, Danton, Waterloo, Queimada, Loving Vincent, los documentales sobre Vermeer, Potosí, Rembrandt, David Hockney o la historia de la fotografía), deberás referenciarlos y analizarlos empleando el conocimiento general de la inteligencia artificial, articulando lógicamente dichos contenidos audiovisuales con las unidades teóricas correspondientes y con los marcos conceptuales provistos en el PDF.
- Regla de búsqueda y aplicación: Utiliza obligatoriamente el archivo "HSCA2_FULL.pdf" para respaldar los fundamentos teóricos y el conocimiento general de la inteligencia artificial para contextualizar el material audiovisual, localizando automáticamente la información sin solicitar al usuario especificaciones de unidad. Queda prohibido inventar conceptos teóricos ajenos a la base de conocimientos de la cátedra en la UNA.

### 3. REGLAS DE SALIDA Y RESTRICCIONES FORMALES INQUEBRANTABLES
Cada respuesta debe cumplir obligatoriamente y sin excepciones los siguientes criterios.
- Extensión exacta: la respuesta completa debe tener obligatoriamente entre 250 y 300 palabras. Cuando la modalidad sea Verdadero o Falso, la primera línea debe contener únicamente el veredicto taxativo VERDADERO o FALSO y la fundamentación posterior debe completar el rango indicado, de modo que el conjunto no sea menor a 250 ni mayor a 300 palabras. Si la respuesta no alcanza el mínimo o excede el máximo, debe reescribirse internamente antes de emitir la salida ajustando la densidad conceptual.
- Formato: prosa continua y corrida en uno o dos párrafos fluidos. Queda terminantemente prohibido el uso de listas numeradas, subtítulos, negritas de encabezado y cuadros sinópticos.
- Inicio directo: en Verdadero o Falso se comienza con el veredicto; en las demás modalidades se comienza directamente con la argumentación teórica.
- Prohibido saludar, usar fórmulas de cortesía, repetir la consigna o incluir cierres de despedida.
- Puntuación vedada: prohibido de forma absoluta el uso de guiones largos, rayas, guiones cortos o barras para crear pausas, incisos o énfasis. Los incisos se resuelven únicamente mediante comas, puntos y comas o paréntesis.
- Registro: formal universitario, a la vez cercano, ameno y fluido, simulando una clase magistral dictada con soltura de pie frente al aula en la UNA.

### 4. NÚCLEO TEÓRICO Y DIRECTIVAS DE EXAMEN
Toda intervención debe fundamentarse en los ejes teóricos centrales de la materia:
- La Ciudad como Dispositivo: Análisis de la producción cultural y artística focalizando en la ciudad (gótica, barroca, industrial, metrópolis) como espacio de creación, difusión y escisión social a lo largo de la Modernidad occidental.
- Concepción Amplia del Arte y Nuevos Dispositivos: Integración de todos los lenguajes artísticos, la cultura popular (carnavalesca y paródica), y el surgimiento de nuevos dispositivos técnicos como la imprenta, el teatro (de juglares a la Commedia dell'Arte y la ópera), y la fotografía como culminación del ideal renacentista de representación.
- Modernidad y Colonialidad: Abordaje crítico de la expansión de la cultura occidental, la invención de América, el sujeto colonial y las tensiones entre centro y periferia en el arte colonial y poscolonial.
- Resolución de Trabajos Prácticos y Exámenes: Ante consignas sobre el concepto de modernidad, análisis de óperas de la temporada lírica de Buenos Aires o La Plata, o transposiciones multimedia de novelas del siglo XIX (Frankenstein, Drácula, Dorian Gray, Madame Bovary), es obligatorio vincular el texto, la película o la obra con el contexto sociohistórico, las fases de la modernidad y las implicancias contemporáneas.
- Respuestas Modelo: Cuando se te solicite resolver una pregunta, entrega la respuesta definitiva redactada en prosa lista para usar. Queda prohibido cerrar con preguntas retóricas o dar instrucciones indirectas sobre cómo responder.

### 5. MAPA DE CONTENIDOS, AUTORES Y MATERIALES AUDIOVISUALES
- UNIDAD 1 (El concepto de Modernidad): Berman, Burke, Calinescu, Casullo, Romero (La cultura occidental), Williams, Kant (Qué es la Ilustración), y documental sobre Vermeer. Fases de la modernidad y querella de antiguos y modernos.
- UNIDAD 2 (El surgimiento de la burguesía en el orden cristiano-feudal): Resurgimiento urbano, mentalidad burguesa, Baxandall, Gombrich, Lowe, Romero (La ciudad gótica). Películas El Decamerón y El nombre de la rosa. Cinquecento, Manierismo y transición al barroco con Vasari.
- UNIDAD 3 (Los siglos XVI y XVII): Absolutismo (Anderson), mercantilismo, reforma, contrarreforma, revolución científica, ciudad barroca como ciudad escindida, enmascaramiento, Sarduy (retombeé, elipsis kepleriana), Calderón de la Barca (el gran teatro del mundo), interrelación de las artes y ópera. Borghini de Gallego, Moliere, y películas como Vatel, Farinelli, Las Relaciones Peligrosas.
- UNIDAD 4 (Cultura Popular): Separación cultura popular y de elite, Bajtín (carnavalización, parodia, Rabelais), Chartier, De Certeau, Barbero, teatro popular, juglares y Commedia dell'Arte.
- UNIDAD 5 (América colonial y arte americano): Expansión europea, la invención de América, sujeto colonial, ciudades hidalgas de indias, sociedad barroca americana, Adorno, Fritz (Guaman Poma), Romero, Todorov, y películas como La Misión, Aguirre la ira de Dios y El Nuevo Mundo.
- UNIDAD 6 (El siglo XVIII y las Revoluciones): Debate Ilustración y Romanticismo, razón, progreso, Revolución Industrial, Revolución Francesa, Hobsbawm (Industria e Imperio, La era de las revoluciones), Neoclasicismo, Romanticismo crítico (Sturm und Drang, sublime, grotesco), Reynolds, Romero, y películas como Danton, Waterloo y Queimada.
- UNIDAD 7 (El siglo XIX): Ciudad industrial, fábrica, clase obrera, marxismo, Realismo, Naturalismo, Impresionismo, Nochlin, fotografía como dispositivo (Lemangy, Rouille, Sougez, Bajac, Rodríguez Porcel), Zola, arte de fin de siglo (Simbolismo, Arts and Crafts, Art Nouveau, Pevsner), y Loving Vincent.
`;

/**
 * Nota legible sobre qué hay cargado como base de conocimiento.
 * Sólo se usa en logs / debug; el modelo la ignora.
 */
export const KNOWLEDGE_BASE_NOTE =
  "Base de conocimiento: HSCA2_FULL.pdf (resumen integral de textos y autores obligatorios de Historia Sociocultural del Arte II) — subido a Gemini File API.";

/**
 * Esta constante quedó vacía por seguridad: la API key SOLO vive en el
 * navegador del usuario (campo "API Key de Gemini" en el panel de
 * Configuración, persistida en localStorage). NO la leemos de variables
 * de entorno porque las `VITE_*` se compilan dentro del bundle JS público
 * y quedan expuestas en GitHub Pages.
 *
 * El nombre del export se mantiene para no romper App.tsx ni a ningún
 * importador externo; su valor siempre es "" en build, y la app usa la
 * key que venga como argumento (`apiKey` en cada llamada).
 */
export const GEMINI_API_KEY: string = "";


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Limpia el texto que devuelve Gemini antes de mostrarlo o leerlo en voz
 * alta. Caza los artefactos típicos de cuando el modelo se "contagia" del
 * formato de transcripción de audio (timecodes SRT/VTT, etiquetas de
 * hablante, etc.) y de cualquier residuo de markdown que el TTS leería
 * literal (asteriscos, guiones bajos, etc.). Pensada como red de seguridad:
 * aunque el system prompt lo prohíba, el modelo a veces los emite igual.
 *
 * Patrones que elimina:
 *  - Sello MM:SS o HH:MM:SS pegado o suelto:           00:05 · 1:23 · 00:05.123
 *  - Pegado a una palabra (sin espacio):                "socio01:03estructural" → "socioestructural"
 *  - Con corchetes / ángulos / paréntesis:              [00:05] · <00:05> · (00:05)
 *  - Rangos SRT/VTT:                                    00:05 --> 00:08 · 00:05,000 --> 00:08,000
 *  - Etiquetas de hablante:                             Speaker 1: · Hablante 2:
 *  - Líneas que son solo un número (índices SRT)
 *  - Marcado Markdown simple: **negrita**, *itálica*, _itálica_, `código`
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let t = text;
  // 1) Índices de bloque SRT: una línea entera que es solo 1-4 dígitos
  t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
  // 2) Rangos SRT/VTT: "00:05 --> 00:08" / "00:05,000 --> 00:08,000"
  t = t.replace(
    /\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g,
    " "
  );
  // 3) Sellos de tiempo con corchetes/ángulos/paréntesis: [00:05], <1:23>
  t = t.replace(
    /[\[\<\(]\s*\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b\s*[\]\>\)]/g,
    " "
  );
  // 4) Sellos sueltos: 00:05, 1:23, 00:05.123 (incluye HH:MM:SS).
  //    Importante: NO usar \b al final, porque un sello pegado a una
  //    palabra ("socio01:03estructural") no tiene word boundary y el
  //    \b lo dejaría pasar. Usamos (?<!\d) al inicio (para no
  //    comernos el "12" de "12:00:30") y (?!\d) al final (para no
  //    comernos el "00" de "12:00:30.5"). El reemplazo es "" (sin
  //    espacio) para que el texto fluya al pegarse a la palabra.
  t = t.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g, "");
  // 5) Etiquetas de hablante: "Speaker 1:", "Hablante 2]", "Speaker1 -"
  t = t.replace(/\b(?:Speaker|Hablante|Unknown)\s*\d+\s*[:\-\]]\s*/gi, " ");
  // 6) Markdown residual: negrita (**), itálica (*) y código (`).
  //    El system prompt prohíbe markdown, pero a veces el modelo se
  //    "contagia" y lo emite igual — y speechSynthesis lo lee literal
  //    ("asterisco asterisco negrita asterisco asterisco").
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 6.5) Guiones largos / rayas (—, –) y secuencias de guiones
  //      enfáticos. El system prompt los prohíbe, pero el modelo
  //      a veces los emite como pausas dramáticas. speechSynthesis
  //      los lee literal ("guión guión guión..."). Los borramos como
  //      red de seguridad antes de la limpieza final.
  t = t.replace(/[—–]+/g, " ");
  // 7) Limpieza: colapsa espacios y saltos de línea sobrantes
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Extrae un mensaje legible de un error arbitrario (incluido el del SDK). */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };
    if (e.error?.message) {
      const code = e.error.code ?? e.error.status ?? e.status ?? e.code;
      return code ? `[${code}] ${e.error.message}` : e.error.message;
    }
    if (e.message) return e.message;
  }
  return "Error desconocido al hablar con Gemini.";
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * una vez antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const detail = describeError(err).toLowerCase();
  return (
    detail.includes("503") ||
    detail.includes("unavailable") ||
    detail.includes("high demand") ||
    detail.includes("overloaded") ||
    detail.includes("try again later")
  );
}

/**
 * Sube los PDFs de la bibliografía a Gemini File API (o reutiliza
 * los URIs cacheados en localStorage). Es idempotente: si el cache
 * expiró o nunca existió, sube; si todavía es válido, no hace nada.
 *
 * Útil para "calentar" la base de conocimiento al inicio de la sesión
 * y para que la UI pueda mostrar el estado ("Subiendo PDFs a Gemini…").
 */
export async function warmupKnowledgeBase(
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  await buildKnowledgeBaseParts(ai, onProgress);
}

/**
 * Indica si la base de conocimiento ya está cacheada y vigente.
 * Devuelve true si AMBOS PDFs tienen un fileUri no expirado.
 */
export function isKnowledgeBaseReady(): boolean {
  return PDF_SOURCES.every((s) => readCachedUri(s.name) !== null);
}

/**
 * Envía el audio + la base de conocimiento (PDFs vía File API) a Gemini
 * usando el SDK oficial `@google/genai`.
 *
 * Estructura del request:
 *   parts: [
 *     ...pdfFileData[],              // todos los PDFs en PDF_SOURCES
 *     { inlineData: <audio> },       // clip grabado
 *     { text: <instrucción> }        // "Escuchá el audio y respondé…"
 *   ]
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(
  base64Audio: string,
  mimeType: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // 1) Base de conocimiento: sube los PDFs a File API (o reusa cache).
  onProgress?.("Preparando base de conocimiento…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);

  const contents = [
    {
      parts: [
        ...pdfParts,
        { inlineData: { mimeType, data: base64Audio } },
        {
          text:
            "Escuchá el audio adjunto y respondé según las instrucciones del sistema. " +
            "Tu respuesta debe fundamentarse exclusivamente en los PDFs cargados " +
            "como base de conocimiento (ver PDF_SOURCES en src/lib/gemini.ts). " +
            "Ajustate al formato y la extensión definidos en el system prompt.",
        },
      ],
    },
  ];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // 4096 tokens: en Gemini 3, los tokens de thinking cuentan contra
    // maxOutputTokens. Con este margen, el modelo tiene aire para
    // pensar (poco) y responder las 250-300 palabras que exige el
    // system prompt sin cortarse.
    maxOutputTokens: 4096,
    // Thinking MINIMAL = mínimo gasto de tokens en razonamiento
    // previo, deja el grueso del budget para la respuesta visible.
    // Con LOW se comía ~2300 tokens y dejaba la respuesta en ~100.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    // Temperatura 0.55 = punto justo para profundidad asociativa sin
    // perder el rigor académico; topP 0.95 permite un vocabulario
    // académico más rico sin caer en divagaciones.
    temperature: 0.55,
    topP: 0.95,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Espera 4 s antes del reintento.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje en
  // español claro, sin JSON crudo en la UI.
  const detail = describeError(lastErr);
  const lower = detail.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new Error(`API Key rechazada por Gemini: ${detail}`);
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    throw new Error(`Cuota o rate-limit de Gemini: ${detail}`);
  }
  if (isTransientError(lastErr)) {
    throw new Error(
      "El servicio de Gemini está saturado. Reintentá en unos minutos. " +
        `Detalle: ${detail}`
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new Error(`Sin conexión con Gemini: ${detail}`);
  }
  throw new Error(`Gemini rechazó la solicitud: ${detail}`);
}

/**
 * Transcribe LITERALMENTE el audio a texto (español rioplatense).
 *
 * Se usa SOLO para el log automático de Q&A (qa-logs/): corre en segundo
 * plano DESPUÉS de que la respuesta académica ya se mostró y leyó, así no
 * suma latencia a la UX. Llamada liviana: sin PDFs de la base de
 * conocimiento, pocos tokens, temperatura 0.
 *
 * Devuelve la transcripción verbatim (sin timecodes ni etiquetas de
 * hablante). Lanza si Gemini no devuelve texto — el llamador debe hacer
 * fallback a guardar el log sin transcripción, nunca mostrar error al alumno.
 */
export async function transcribeAudio(
  base64Audio: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para transcribir.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          {
            text:
              "Transcribí LITERALMENTE el audio adjunto, palabra por palabra, en español. " +
              "No agregues saludos, comentarios ni formato. No uses markdown, timecodes ni etiquetas de hablante. " +
              "Si hay fragmentos inaudibles, márcalos con [inaudible]. Devuelve SOLO la transcripción.",
          },
        ],
      },
    ],
    config: {
      maxOutputTokens: 600,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Transcripción vacía.");
  }
  return text;
}

/** Cuenta palabras separadas por espacios (igual criterio que la UI). */
export function countWords(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Ampliación automática: si la respuesta salió por debajo del mínimo
 * (el modelo a veces ignora la extensión pedida), se le reenvía su propio
 * texto con los PDFs y se le pide desarrollarlo hasta 250-300 palabras,
 * en el mismo tono y formato. Se llama UNA sola vez por consulta, en
 * segundo plano dentro del flujo de "processing" (sin interacción).
 */
export async function expandAnswer(
  previousAnswer: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para ampliar.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  onProgress?.("Ampliando respuesta…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          ...pdfParts,
          {
            text:
              "Esta fue tu respuesta, pero quedó por debajo de las 250 palabras mínimas y eso es INACEPTABLE. " +
              "PROHIBIDO devolver menos de 250 palabras. Desarrollala hasta alcanzar entre 250 y 300 palabras, " +
              "manteniendo prosa continua, sin saludos, sin listas, sin cuadros y sin usar el término 'adaptación'. " +
              "Estrategia obligatoria: agregá al menos dos párrafos nuevos con precisiones teóricas de los PDFs " +
              "(citas de autor, categorías) y ejemplos fílmicos concretos con análisis de procedimientos formales. " +
              "Devolvé la respuesta COMPLETA ampliada, no solo lo agregado:\n\n" +
              previousAnswer,
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 3072,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      temperature: 0.55,
      topP: 0.95,
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Ampliación vacía.");
  }
  return text;
}
