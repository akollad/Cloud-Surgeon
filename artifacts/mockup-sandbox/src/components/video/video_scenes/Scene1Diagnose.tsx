import { motion } from 'framer-motion';

export function Scene1Diagnose() {
  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center p-[5vw]"
      initial={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: '-5vh' }}
      transition={{ duration: 0.8 }}
    >
      <div className="w-full max-w-[80vw] border border-primary/30 bg-background/80 backdrop-blur-xl rounded-xl overflow-hidden flex flex-col shadow-[0_0_50px_rgba(0,212,255,0.1)]">
        {/* Header */}
        <div className="border-b border-primary/20 px-[2vw] py-[1.5vw] flex items-center gap-[1vw] bg-primary/5">
          <div className="w-[1vw] h-[1vw] rounded-full bg-primary animate-pulse" />
          <div className="font-mono text-primary text-[1.5vw]">DIAGNOSTICIAN_AGENT</div>
        </div>
        
        <div className="p-[3vw] font-mono flex flex-col gap-[2vw]">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 }}
            className="text-muted-foreground text-[1.8vw]"
          >
            &gt; Querying CockroachDB Vector Memory...
          </motion.div>
          
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.5 }}
            className="bg-muted/50 p-[2vw] rounded-lg text-primary/80 border border-primary/20 text-[1.8vw] leading-[1.6]"
          >
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5 }}>SELECT</motion.span> strategy <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.6 }}>FROM</motion.span> memory<br/>
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.7 }}>WHERE</motion.span> incident_vector &lt;-&gt; query_vector<br/>
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.8 }}>ORDER BY</motion.span> win_rate <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.9 }}>DESC LIMIT 1;</motion.span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 3.5, type: 'spring', stiffness: 200 }}
            className="border border-accent/40 bg-accent/10 p-[2vw] rounded-lg flex items-center justify-between"
          >
            <div>
              <div className="text-accent/60 text-[1vw] mb-[0.5vw] uppercase tracking-widest">Match Found</div>
              <div className="text-accent text-[2.5vw] font-bold tracking-tight">"ECS Fargate Redeploy"</div>
            </div>
            <div className="text-right">
              <div className="text-accent/60 text-[1vw] mb-[0.5vw] uppercase tracking-widest">Win-Rate</div>
              <div className="text-accent text-[3vw] font-bold">92.4%</div>
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}