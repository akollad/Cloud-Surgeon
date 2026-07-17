import { motion } from 'framer-motion';

// Pre-computed to avoid Math.random() during render
const KERNEL_LINES = [
  '[1234.567890] kernel: Out of memory: Killed process 84312 (agent_core)',
  '[1234.601234] kernel: Out of memory: Killed process 84313 (mcp_server)',
  '[1234.712345] kernel: Out of memory: Killed process 84401 (db_pool)',
  '[1235.001234] kernel: CPU stall detected on core 2, task 84312',
  '[1235.123456] kernel: Out of memory: Killed process 84512 (ecs_watcher)',
  '[1235.234567] kernel: Out of memory: Killed process 84601 (audit_loop)',
  '[1235.345678] kernel: Out of memory: Killed process 84702 (vec_indexer)',
  '[1235.456789] kernel: Out of memory: Killed process 84801 (agent_core)',
  '[1235.567890] kernel: Out of memory: Killed process 84902 (remediator)',
  '[1235.678901] kernel: Out of memory: Killed process 85001 (diagnostician)',
  '[1235.789012] kernel: Out of memory: Killed process 85102 (auditor)',
  '[1235.890123] kernel: Out of memory: Killed process 85201 (state_mgr)',
  '[1236.001234] kernel: BUG: unable to handle kernel NULL pointer dereference',
  '[1236.112345] kernel: RIP: oom_kill_process+0x1a8/0x200',
  '[1236.223456] kernel: Kernel panic - not syncing: system is dead',
];

export function Scene4Chaos() {
  return (
    <motion.div 
      className="absolute inset-0 bg-destructive/10 z-30 flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1 }} // Snappy transition for crash
    >
      
      {/* Glitch Overlay */}
      <motion.div 
        className="absolute inset-0 bg-destructive mix-blend-overlay z-40 pointer-events-none"
        animate={{ opacity: [0, 0.8, 0, 0.4, 0] }}
        transition={{ duration: 0.4, times: [0, 0.1, 0.2, 0.3, 1] }}
      />

      {/* Terminal Kernel Panic */}
      <motion.div
        className="w-[90vw] h-[80vh] font-mono text-destructive text-[1.5vw] leading-tight overflow-hidden p-[4vw]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="text-[4vw] font-bold mb-[2vw]">SIGKILL RECEIVED</div>
        {KERNEL_LINES.map((line, i) => (
          <motion.div 
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.05 }}
            className="opacity-80"
          >
            {line}
          </motion.div>
        ))}
      </motion.div>

      {/* The Recovery */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 50 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ delay: 2, duration: 1, ease: 'circOut' }}
        className="absolute inset-0 bg-background/95 backdrop-blur-xl flex flex-col items-center justify-center z-50 p-[5vw]"
      >
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="text-primary font-mono text-[2vw] mb-[4vw] tracking-[0.5em]"
        >
          REBOOTING...
        </motion.div>

        <div className="w-full max-w-[60vw] bg-muted/30 border border-primary/20 rounded-xl p-[4vw]">
          <div className="font-sans text-[3vw] mb-[2vw] font-bold text-center">
            Crash Resilient.
          </div>
          <div className="font-mono text-[1.5vw] text-foreground/80 flex flex-col gap-[1vw]">
             <div>&gt; Reading JSONB agent state...</div>
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3.5 }}>&gt; Found incomplete task: <span className="text-accent">redeploy_fargate()</span></motion.div>
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 4.5 }}>&gt; Resuming exactly where it left off.</motion.div>
          </div>
        </div>

      </motion.div>

    </motion.div>
  );
}