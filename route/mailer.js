const internalMailer = require('../lib/internal-mailer')
const postieMailer = require('../lib/postie-mailer')

module.exports = {
    Mailer: async (ctx, next) => {
        let mailConfig = await ctx.db.collection('meta').findOne({ _id: 'mail' })
        
        if ( ! mailConfig ) {
            ctx.status = 412
            ctx.body = { error: 'internal mail not configured' }
            return
        }
    
        ctx.mailConfig = mailConfig
        
        if (ctx.POSTIE)
            return await postieMailer(ctx, next)
        else
            return await internalMailer(ctx, next)
    }
}
