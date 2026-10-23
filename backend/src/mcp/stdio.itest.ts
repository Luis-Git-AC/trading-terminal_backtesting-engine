import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_NAMES } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_NAME } from './server.js';

/**
 * Arranca el rol de verdad en otro proceso y habla con el por stdio, que es como lo arrancan Claude
 * Code y la app de escritorio. Lo que prueba y no prueba el test en memoria: que `START_MODE=mcp`
 * levanta el servidor y que **el log no contamina stdout**, porque stdout es el canal JSON-RPC y
 * una sola linea de log ahi rompe la sesion.
 */
describe('MCP por stdio', () => {
  it('un cliente que lanza el proceso completa el handshake y lista las tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        new URL('../main.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'),
        'mcp',
      ],
      env: { ...process.env, START_MODE: 'mcp', LOG_LEVEL: 'debug' },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'itest-stdio', version: '0.0.0' });
    try {
      await client.connect(transport);

      expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());

      // Con LOG_LEVEL=debug el servidor ha escrito logs; si hubieran ido a stdout, el handshake de
      // arriba habria fallado al parsear. Ademas, aqui se comprueba que estan en stderr.
      const chunks: string[] = [];
      transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      await client.callTool({ name: 'list_events', arguments: { from: 0, limit: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(chunks.join('')).not.toContain('"jsonrpc"');
    } finally {
      await client.close();
    }
  }, 60_000);
});
