import { motion } from 'framer-motion';

export function Scene2Repair() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center p-[5vw]"
      initial={{ opacity: 0, x: '5vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
      transition={{ duration: 0.8 }}
    >
      <div className="w-full max-w-[80vw] h-[60vh] flex">
        
        {/* Left: Terminal execution */}
        <div className="flex-1 border border-muted-foreground/30 bg-background/90 backdrop-blur-xl rounded-l-xl overflow-hidden flex flex-col">
          <div className="border-b border-muted-foreground/20 px-[2vw] py-[1.5vw] flex items-center gap-[1vw] bg-muted/30">
            <div className="w-[1vw] h-[1vw] rounded-full bg-primary" />
            <div className="font-mono text-muted-foreground text-[1.5vw]">AGENT.REMEDIATOR [AWS]</div>
          </div>
          <div className="p-[3vw] font-mono text-[1.5vw] flex flex-col gap-[1vw] flex-1 overflow-hidden">
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
               <span className="text-primary">$</span> aws ecs update-service \
             </motion.div>
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="ml-[2vw] text-foreground/80">
               --cluster prod-cluster \
             </motion.div>
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="ml-[2vw] text-foreground/80">
               --service checkout-svc \
             </motion.div>
             <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="ml-[2vw] text-foreground/80 mb-[2vw]">
               --force-new-deployment
             </motion.div>

             <motion.div 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: 1.5 }}
                className="text-accent/80"
             >
               &gt; Initiating rolling update...
             </motion.div>
             
             <motion.div 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: 2.5 }}
                className="text-accent/80"
             >
               &gt; Draining old tasks [2/2]...
             </motion.div>

             <motion.div 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: 4 }}
                className="text-primary font-bold mt-auto"
             >
               ✔ SUCCESS: Service healthy.
             </motion.div>
          </div>
        </div>

        {/* Right: Visual state */}
        <div className="flex-1 border border-l-0 border-primary/30 bg-primary/5 rounded-r-xl p-[3vw] flex flex-col items-center justify-center relative overflow-hidden">
          {/* AWS Logo Hint */}
          <div className="absolute top-[2vw] right-[2vw] opacity-25 font-bold font-mono text-[1.8vw] text-foreground tracking-widest">
            AWS
          </div>

          <div className="text-center font-mono text-[2vw] text-primary/80 mb-[4vw] tracking-widest uppercase">
            Cluster State
          </div>

          <div className="flex gap-[2vw]">
            {/* Old task */}
            <motion.div
              animate={{
                opacity: [1, 0],
                y: [0, 50],
                scale: [1, 0.8]
              }}
              transition={{ delay: 1.5, duration: 1 }}
              className="w-[12vw] h-[15vw] border-2 border-destructive bg-destructive/10 rounded-lg flex flex-col items-center justify-center gap-[1vw]"
            >
              <div className="w-[3vw] h-[3vw] rounded-full bg-destructive/50" />
              <div className="font-mono text-destructive text-[1.5vw]">v1.4.2</div>
              <div className="font-mono text-destructive/60 text-[1vw]">FAULTY</div>
            </motion.div>

             {/* New task */}
             <motion.div
              initial={{ opacity: 0, y: -50, scale: 0.8 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1
              }}
              transition={{ delay: 2.5, duration: 1, type: 'spring', stiffness: 200 }}
              className="w-[12vw] h-[15vw] border-2 border-primary bg-primary/10 rounded-lg flex flex-col items-center justify-center gap-[1vw]"
            >
              <div className="w-[3vw] h-[3vw] rounded-full bg-primary/80" />
              <div className="font-mono text-primary text-[1.5vw]">v1.4.3</div>
              <div className="font-mono text-primary/60 text-[1vw]">HEALTHY</div>
            </motion.div>
          </div>
        </div>

      </div>
    </motion.div>
  );
}