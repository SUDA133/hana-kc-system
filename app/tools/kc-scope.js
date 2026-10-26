// Retired file-system exemption. KC only protects its own data operations now.
export const name='kc-scope';
export const description='兼容旧调用的退役入口：KC5不对普通文件删除设置豁免；知识卡删除仍需confirm与归档。';
export const parameters={type:'object',properties:{action:{type:'string',enum:['open','close','list']},root:{type:'string'},reason:{type:'string'}},required:['action']};
export async function execute(){return{content:[{type:'text',text:'kc_scope已退役，无需开启文件系统删除豁免。未修改旧scope数据；kc_delete自身确认和删除前归档保护不变。'}],details:{retired:true,policyVersion:5},isError:false};}
