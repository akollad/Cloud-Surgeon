import { motion } from 'framer-motion';

export function Scene6Outro() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center p-[5vw] z-50 bg-background"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.5 }}
    >
      <div className="text-center w-full max-w-[80vw]">
        
        {/* Core Value Props */}
        <div className="flex justify-center gap-[4vw] mb-[8vw]">
          <ValueProp text="80% Faster MTTR" delay={1} />
          <ValueProp text="No Pager" delay={1.5} />
          <ValueProp text="No Runbooks" delay={2} />
        </div>

        {/* Title Reveal */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0, y: 50 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ delay: 3.5, duration: 1.5, type: 'spring', stiffness: 100 }}
          className="relative inline-block"
        >
          <div className="absolute inset-0 bg-primary/20 blur-[50px] rounded-full" />
          <h1 className="text-[8vw] font-bold tracking-tighter relative z-10">
            Cloud-Surgeon
          </h1>
          <div className="font-mono text-[1.5vw] text-primary tracking-[0.5em] mt-[1vw] uppercase">
            Autonomous AI DevOps
          </div>
        </motion.div>

        {/* Logos */}
        <motion.div 
          className="flex justify-center items-center gap-[4vw] mt-[8vw] opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.6 }}
          transition={{ delay: 5, duration: 1 }}
        >
          <div className="font-mono text-[1.2vw] text-foreground/50">POWERED BY</div>
          <div className="text-[2vw] font-bold font-sans">CockroachDB</div>
          <div className="w-[1vw] h-[1vw] rounded-full bg-foreground/20" />
          <div className="text-[2vw] font-bold font-sans">AWS</div>
        </motion.div>

      </div>
    </motion.div>
  );
}

function ValueProp({ text, delay }: { text: string, delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.8 }}
      className="text-[3vw] font-bold text-transparent bg-clip-text bg-gradient-to-br from-foreground to-foreground/50"
    >
      {text}
    </motion.div>
  );
}