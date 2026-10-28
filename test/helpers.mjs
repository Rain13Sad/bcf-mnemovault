/** 测试用统一出口：所有用例从编译产物导入，测的就是发布的那份代码。 */
export * from '../packages/core/lib/index.js'
export { retrievability as computeR } from '../packages/core/lib/forgetting.js'
