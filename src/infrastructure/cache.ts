/**
 * Memoria de corta duración para lo que lee el portal ciudadano en cada visita y casi nunca cambia (listas del
 * formulario y texto de autorización). Evita repetir las mismas consultas cientos de veces por segundo cuando se abre
 * una convocatoria (RNF-09). Las cargas simultáneas de la misma clave se comparten.
 *
 * Quien cambia esos datos desde el portal interno llama a `invalidar()`, así que en una sola instancia el cambio se ve
 * al instante; con varias instancias se ve en, como máximo, el tiempo de vida indicado. En pruebas automáticas la
 * memoria está apagada para que cada caso vea siempre lo último.
 */
export class MemoriaCorta {
  private readonly entradas = new Map<string, { vence: number; valor: Promise<unknown> }>();

  constructor(private readonly vidaMs: number) {}

  async obtener<T>(clave: string, cargar: () => Promise<T>): Promise<T> {
    if (this.vidaMs <= 0) return cargar();
    const ahora = Date.now();
    const e = this.entradas.get(clave);
    if (e && e.vence > ahora) return e.valor as Promise<T>;
    const valor = cargar();
    this.entradas.set(clave, { vence: ahora + this.vidaMs, valor });
    // Si la carga falla no se guarda: la siguiente petición lo intenta de nuevo.
    valor.catch(() => this.entradas.delete(clave));
    return valor;
  }

  invalidar(): void {
    this.entradas.clear();
  }
}

/** Datos públicos del formulario: 15 segundos (0 en pruebas). */
export const memoriaPublica = new MemoriaCorta(process.env['NODE_ENV'] === 'test' ? 0 : 15_000);
