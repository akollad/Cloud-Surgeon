import { motion } from 'framer-motion';

export function Scene3Memory() {
  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center z-20"
      initial={{ opacity: 0, scale: 1.2 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, y: '5vh' }}
      transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full flex flex-col items-center">
        
        {/* Cockroach logo / Brain representation */}
        <motion.div 
          className="relative w-[15vw] h-[15vw] mb-[6vw]"
          animate={{ rotate: 360 }}
          transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
        >
           {/* Abstract DB ring */}
           <div className="absolute inset-0 rounded-full border border-dashed border-primary/40 animate-[spin_10s_linear_infinite_reverse]" />
           <div className="absolute inset-[10%] rounded-full border border-dotted border-accent/40 animate-[spin_15s_linear_infinite]" />
           
           <div className="absolute inset-0 flex items-center justify-center">
             <div className="font-sans font-bold text-[3vw] text-foreground">
                CRDB
             </div>
           </div>
        </motion.div>

        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="text-[4vw] font-bold text-center mb-[2vw]"
        >
          CockroachDB <span className="font-normal italic opacity-60">is</span> the brain.
        </motion.h2>

        {/* CDC Stream visualization */}
        <div className="w-full max-w-[70vw] relative h-[20vh] border-y border-primary/20 bg-background/50 backdrop-blur-sm overflow-hidden flex items-center">
           <div className="absolute left-0 top-0 bottom-0 w-[10vw] bg-gradient-to-r from-background to-transparent z-10" />
           <div className="absolute right-0 top-0 bottom-0 w-[10vw] bg-gradient-to-l from-background to-transparent z-10" />
           
           <div className="flex gap-[4vw] px-[10vw] absolute whitespace-nowrap">
             {/* Simulating CDC stream flowing right to left */}
             <motion.div 
                className="flex gap-[4vw]"
                animate={{ x: ['0%', '-50%'] }}
                transition={{ duration: 10, ease: 'linear', repeat: Infinity }}
             >
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="flex gap-[4vw]">
                    <StreamNode type="ALERT" data="{type:'P0', svc:'checkout'}" color="var(--color-destructive)" delay={0} />
                    <StreamNode type="VECTOR" data="[0.12, 0.94, -0.4...]" color="var(--color-primary)" delay={0.2} />
                    <StreamNode type="ACTION" data="redeploy_fargate()" color="var(--color-accent)" delay={0.4} />
                    <StreamNode type="STATE" data="{status:'healthy'}" color="var(--color-foreground)" delay={0.6} />
                  </div>
                ))}
             </motion.div>
           </div>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="mt-[2vw] font-mono text-muted-foreground text-[1.5vw]"
        >
          &gt; CDC streaming incident state via SSE
        </motion.div>

      </div>
    </motion.div>
  );
}

function StreamNode({ type, data, color, delay }: { type: string, data: string, color: string, delay: number }) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay }}
      className="flex flex-col items-center gap-[1vw]"
    >
      <div 
        className="px-[1.5vw] py-[0.5vw] rounded-full font-mono text-[1.2vw] font-bold"
        style={{ color: color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
      >
        {type}
      </div>
      <div className="font-mono text-[1vw] opacity-50">{data}</div>
    </motion.div>
  );
}