// Compatibility no-op. A short acknowledgement cannot certify knowledge use.
export const name='kc-acknowledge';
export const description='兼容旧调用的退役入口：KC5不再要求知识确认打卡，不修改门禁或知识卡片。';
export const parameters={type:'object',properties:{summary:{type:'string'}}};
export async function execute(){return{content:[{type:'text',text:'此确认入口已退役：KC5无需全局ACK，未修改知识、候选或旧门禁记录。'}],details:{retired:true,policyVersion:5,ordinaryToolGate:false},isError:false};}
