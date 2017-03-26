const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSelfOrAdmin, School } = require('./school')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')
const { readFile, unlink } = require('mz/fs')

route.post('/schools/:id/payments/',
    IsSelfOrAdmin,
    LogOp('payment', 'payment'),
    School,
    async ctx => {
       if ( ! ctx.is('multipart') ) {
           ctx.status = 415
           ctx.body = { status: false, message: 'Expect multipart/form-data' }
           return
       }

       let { round } = ctx.query
       let { stage } = ctx.school

       if ( String(stage[0]) != String(round) || !stage.endsWith('payment') ) {
          ctx.status = 412
          ctx.body = { error: 'incorrect school stage' }
          return
       }

       let { path, type, size } = ctx.request.body.files.file

       if ( size > 2*1024*1024 ) {
          ctx.status = 400
          ctx.body = { error: 'too large' }
          return
       }

       let {
         insertedId
       } = await ctx.db.collection('payment').insertOne({
          _id: newId(),
          school: ctx.params.id,
          created: new Date(),
          round,
          size,
          mime: type,
          buffer: await readFile(path),
       })

       // update stage -> paid
       let nextStage = ctx.school.stage.replace('.payment', '.paid')
       if ( nextStage !== ctx.school.stage ) {
           await ctx.db.collection('school').updateOne(
               { _id: ctx.params.id, stage: ctx.school.stage },
               { $set: { stage: nextStage } }
           )
       } else {
           ctx.status = 412
           ctx.body = { error: 'incorrect school stage' }
           return
       }

       ctx.status = 200
       ctx.body = { id: insertedId }
   }
)

route.get('/schools/:id/payments/',
    IsSelfOrAdmin,
    async ctx => {
        let filter = { school: ctx.params.id }
        if (ctx.query.round)
           filter[round] = String(ctx.query.round)

        ctx.status = 200
        ctx.body = await ctx.db.collection('payment').aggregate([
            { $match: filter },
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                time: '$created',
                round: { $ifNull: ['$round', '1'] },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                }
            } }
        ]).toArray()
    }
)

route.get('/schools/:id/payments/:pid',
    IsSelfOrAdmin,
    async ctx => {
        let payment = await ctx.db.collection('reservation').findOne({ _id: ctx.params.pid, school: ctx.params.id })
        if (payment) {
            ctx.status = 200
            ctx.set('Content-Type', payment.mime)
            ctx.set('X-Created-Date', new Date(payment.created).toISOString())
            ctx.body = payment.buffer
            ctx.status = 200
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
